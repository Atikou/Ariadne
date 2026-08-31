import { describe, expect, it, vi } from 'vitest';

import {
  compileAgentPublicCommandOwnerTable,
  type AgentPublicCommandOwner
} from '../src/composition/agent-entity/command-owners/AgentPublicCommandOwnerTable.js';
import type { RuntimeCommandEnvelope } from '../src/ingress/RuntimeIngress.js';

describe('Agent public command owner table', () => {
  it('routes execute and reconcile through one frozen owner snapshot', async () => {
    const execute = vi.fn(async () => ({
      outcome: { ok: true as const, result: { kind: 'projection.snapshot' as const } },
      settlement: 'completed' as const
    }));
    const reconcile = vi.fn(async () => ({ kind: 'not_committed' as const }));
    const owner: AgentPublicCommandOwner = {
      id: 'projection.query',
      commandKinds: ['projection.snapshot.get'],
      execute,
      reconcile
    };
    const table = compileAgentPublicCommandOwnerTable([owner]);
    const envelope = projectionEnvelope();

    await table.execute(envelope);
    await table.reconcile(envelope);

    expect(execute).toHaveBeenCalledWith(envelope);
    expect(reconcile).toHaveBeenCalledWith(envelope);
    expect(table.diagnosticSnapshot()).toEqual([{
      id: 'projection.query',
      commandKinds: ['projection.snapshot.get']
    }]);
    expect(Object.isFrozen(table.diagnosticSnapshot())).toBe(true);
  });

  it('fails before readiness on duplicate ids or command ownership', () => {
    const owner = (id: string): AgentPublicCommandOwner => ({
      id,
      commandKinds: ['projection.snapshot.get'],
      execute: async () => ({
        outcome: { ok: true, result: { kind: 'projection.snapshot' } },
        settlement: 'completed'
      }),
      reconcile: async () => ({ kind: 'not_committed' })
    });

    expect(() => compileAgentPublicCommandOwnerTable([owner('first'), owner('second')]))
      .toThrow('agent_command_owner_duplicate:projection.snapshot.get:first:second');
    expect(() => compileAgentPublicCommandOwnerTable([owner('same'), {
      ...owner('same'), commandKinds: ['projection.commits.read']
    }])).toThrow('agent_command_owner_id_duplicate:same');
  });

  it('returns null only when another domain owns the command', async () => {
    const table = compileAgentPublicCommandOwnerTable([]);
    await expect(table.execute(projectionEnvelope())).resolves.toBeNull();
    await expect(table.reconcile(projectionEnvelope())).resolves.toBeNull();
  });
});

function projectionEnvelope(): RuntimeCommandEnvelope {
  return {
    commandId: 'command-1',
    correlationId: 'correlation-1',
    deadlineAt: '2031-01-01T00:00:00.000Z',
    signal: new AbortController().signal,
    command: {
      kind: 'projection.snapshot.get',
      contractVersion: 3
    }
  };
}
