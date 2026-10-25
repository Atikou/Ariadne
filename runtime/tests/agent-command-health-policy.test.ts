import { describe, expect, it, vi } from 'vitest';
import type { RuntimeCommand } from '@ariadne/protocol/public';
import { compileAgentCommandHealthPolicy } from '../src/composition/agent-entity/AgentCommandHealthPolicy.js';
import { AgentEntityHealth } from '../src/composition/agent-entity/AgentEntityHealth.js';
import { RuntimeDomainHealth } from '../src/ingress/RuntimeDomainHealth.js';
import { commandRequiresInference } from '../src/ingress/RuntimeInferenceAdmission.js';

const owners = [
  { id: 'conversation.sessions', commandKinds: ['conversation.session.create'] as const },
  { id: 'conversation.message', commandKinds: ['conversation.message.accept'] as const },
  { id: 'projection.query', commandKinds: ['projection.catalog.begin'] as const },
  { id: 'workspace-documents', commandKinds: ['workspace.document.read'] as const },
  { id: 'long-memory', commandKinds: ['memory.read'] as const },
  { id: 'productivity', commandKinds: ['productivity.query', 'schedule.transition'] as const }
];
const command = (kind: RuntimeCommand['kind'], extra: object = {}) => ({ kind, ...extra } as RuntimeCommand);
const healthy = () => ({ assertHealthy: vi.fn() });

describe('command health compiled from the existing production owners', () => {
  it('shares the single inference latch with internal worker admission and keeps reads and cancellation independent', async () => {
    const inference = new RuntimeDomainHealth();
    inference.register('inference', { probe: () => { throw new Error('actual unavailable qualification source'); },
      failureCode: 'authority_unavailable', recovery: 'repair' });
    const execution = healthy(), projection = healthy(), conversation = healthy(), productivity = healthy();
    const health = new AgentEntityHealth(execution, projection, {}, { execution, conversation, productivity }, owners,
      candidate => { if (commandRequiresInference(candidate)) inference.assertAvailable(['inference']); });
    const execute = vi.fn(async () => null);
    await expect(health.execute({ commandId: 'original-worker-message', correlationId: 'worker', deadlineAt: '2031-01-01T00:00:00.000Z',
      signal: new AbortController().signal, command: command('conversation.message.accept') }, execute))
      .resolves.toMatchObject({ settlement: 'completed', outcome: { ok: false, error: { code: 'runtime_inference_unavailable' } } });
    expect(execute).not.toHaveBeenCalled();
    for (const candidate of [command('conversation.session.create'), command('agent.run.cancel'), command('productivity.task.reconcile'),
      command('workflow.start', { executionMode: 'manual' })]) {
      expect(commandRequiresInference(candidate)).toBe(false);
      expect(() => health.assertCommandHealthy(candidate)).not.toThrow();
    }
    expect(commandRequiresInference(command('schedule.create'))).toBe(false);
    expect(health.read().some(row => row.domain === 'inference')).toBe(false);
    expect(inference.read()).toEqual([expect.objectContaining({ domain: 'inference', availability: 'unavailable' })]);
  });
  it('binds the actual memory probe without blocking independent Session creation', () => {
    const execution = healthy(), projection = healthy(), conversation = healthy(), memory = healthy();
    const health = new AgentEntityHealth(execution, projection, {}, { execution, conversation, memory }, owners);
    memory.assertHealthy.mockImplementation(() => { throw new Error('private memory source'); });
    expect(() => health.assertCommandHealthy(command('memory.read'))).toThrow('runtime_domain_unavailable:memory');
    expect(() => health.assertCommandHealthy(command('conversation.session.create'))).not.toThrow();
    expect(health.read().find(row => row.domain === 'memory')).toMatchObject({ availability: 'unavailable', recovery: 'repair' });
    expect(JSON.stringify(health.read())).not.toContain('private memory source');
  });
  it('rejects an added unclassified owner during composition', () => {
    expect(() => compileAgentCommandHealthPolicy([{ id: 'new-owner', commandKinds: ['runtime.status.get'] }]))
      .toThrow('agent_command_health_owner_unclassified:new-owner');
  });
  it('maps only real owner contributions and adds execution for an automatic resume', () => {
    const read = compileAgentCommandHealthPolicy(owners);
    expect(read(command('workspace.document.read'))).toEqual([]);
    expect(read(command('conversation.session.create'))).toEqual(['conversation', 'projection']);
    expect(read(command('schedule.transition', { action: 'resume' }))).toEqual(['conversation', 'productivity', 'execution']);
    expect(read(command('schedule.transition', { action: 'pause' }))).toEqual(['conversation', 'productivity']);
    expect(read(command('runtime.status.get'))).toEqual([]); // Actual Kernel status owns no Agent reads.
  });
  it('allows independent document and productivity operations after an execution fault, but rejects projected data and new runs', () => {
    const source = healthy(), execution = healthy(), projection = healthy(), conversation = healthy(), productivity = healthy();
    const health = new AgentEntityHealth(execution, projection, {}, { execution: source, conversation, productivity }, owners);
    source.assertHealthy.mockImplementation(() => { throw new Error('private Agent storage payload'); });
    expect(() => health.assertCommandHealthy(command('conversation.message.accept'))).toThrow('runtime_domain_unavailable:execution');
    expect(() => health.assertCommandHealthy(command('projection.catalog.begin'))).toThrow('runtime_domain_unavailable:execution');
    expect(() => health.assertCommandHealthy(command('workspace.document.read'))).not.toThrow();
    expect(() => health.assertCommandHealthy(command('productivity.query'))).not.toThrow();
    expect(health.read().find(row => row.domain === 'execution')).toMatchObject({ availability: 'unavailable', source: 'execution' });
    expect(JSON.stringify(health.read())).not.toContain('private Agent storage payload');
  });
  it('binds real Conversation/Productivity source failures and never rejects another owner for absent optional Productivity', () => {
    const execution = healthy(), projection = healthy(), conversation = healthy();
    const health = new AgentEntityHealth(execution, projection, {}, { execution, conversation }, owners);
    expect(() => health.assertCommandHealthy(command('productivity.query'))).toThrow('runtime_domain_unavailable:productivity');
    expect(() => health.assertCommandHealthy(command('conversation.session.create'))).not.toThrow();
    conversation.assertHealthy.mockImplementation(() => { throw new Error('bad Conversation data'); });
    expect(() => health.assertCommandHealthy(command('conversation.session.create'))).toThrow('runtime_domain_unavailable:conversation');
    expect(() => health.assertCommandHealthy(command('workspace.document.read'))).not.toThrow();
  });
  it('gates internal worker dispatch through the same dependencies but preserves mutation uncertainty', async () => {
    const execution = healthy(), projection = healthy(), conversation = healthy(), productivity = healthy();
    const health = new AgentEntityHealth(execution, projection, {}, { execution, conversation, productivity }, owners);
    const mutationFailure = new Error('reply lost after actual mutation');
    const execute = vi.fn(async () => { throw mutationFailure; });
    const envelope = { commandId: 'same-original-command', correlationId: 'internal-worker',
      deadlineAt: '2031-01-01T00:00:00.000Z', signal: new AbortController().signal,
      command: command('conversation.message.accept') };
    await expect(health.execute(envelope, execute)).rejects.toBe(mutationFailure);
    execution.assertHealthy.mockImplementation(() => { throw new Error('actual source failure'); });
    await expect(health.execute(envelope, execute)).resolves.toMatchObject({ settlement: 'completed',
      outcome: { ok: false, error: { code: 'runtime_execution_unavailable', retryable: false } } });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
