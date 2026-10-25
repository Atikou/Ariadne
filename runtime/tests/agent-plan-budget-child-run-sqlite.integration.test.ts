import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  AgentPlanBudgetChildRunService,
  AgentRunCommandService,
  AgentRunInvariantError,
  AgentRunAncestorCancellationError,
  AgentEffectDispatchService,
  digestAgentTurnInput,
  summarizeAgentTurnInput,
  sha256AgentControlData,
  type AgentBudgetVector,
  type AgentControlJsonValue,
  type AgentRunBinding,
  type AgentRunCheckpointCommit
} from '@ariadne/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_PROJECTION_CONTRACT_VERSION } from '@ariadne/protocol/public';
import { AgentRunCancellationService } from '../src/composition/agent-entity/components/run-control/AgentRunCancellationService.js';
import { createAgentRunControlComponent } from '../src/composition/agent-entity/components/run-control/AgentRunControlComponent.js';
import { AgentParentCancellationGate } from '../src/control/execution/AgentParentCancellationGate.js';
import { AgentRunWorkClassifier } from '../src/control/execution/AgentRunWorkClassifier.js';
import { AgentStartedWorkRecoveryCoordinator } from '../src/control/execution/AgentStartedWorkRecoveryCoordinator.js';
import { AgentChildTerminalObservationCoordinator } from '../src/control/execution/AgentChildTerminalObservationCoordinator.js';
import { AgentRunPublicProjectionPublisher } from '../src/projection/AgentRunPublicProjectionPublisher.js';
import { SqlitePublicProjectionStore } from '../src/adapters/persistence/SqlitePublicProjectionStore.js';
import { Sha256AgentEffectInputDigester } from '../src/adapters/persistence/Sha256AgentEffectInputDigester.js';
import { V3AgentEffectDispatchCheckpointFactory } from '../src/control/execution/AgentEffectDispatchCheckpointFactory.js';

import {
  SqliteAgentRunUnitOfWork
} from '../src/adapters/persistence/SqliteAgentRunUnitOfWork.js';
import {
  AgentRetiredToolCatalogTerminalizationCoordinator
} from '../src/control/execution/AgentRetiredToolCatalogTerminalizationCoordinator.js';
import {
  resolveAgentControlDatabasePath
} from '../src/adapters/persistence/agentControlDbSchema.js';
import { createShutdownContext } from '../src/ingress/ShutdownContext.js';
import { HostProcessSandbox } from '../src/sandbox/HostProcessSandbox.js';
import type { AgentProcessSandbox } from '../src/control/ports/AgentProcessSandbox.js';
import { createWorkspaceAgentToolRegistrations } from '../src/composition/first-party-tools/WorkspaceAgentTools.js';
import { compileTrustedAgentToolCatalog } from '../src/adapters/tool/TrustedAgentToolCatalogCompiler.js';
import { ImmutableAgentToolCatalogRegistry } from '../src/adapters/tool/ImmutableAgentToolCatalogRegistry.js';

const roots: string[] = [];
const openUnits = new Set<SqliteAgentRunUnitOfWork>();

afterEach(async () => {
  await Promise.all([...openUnits].map(closeUnit));
  openUnits.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ADR-0009 Plan/Budget/ordinary child Run SQLite slice', () => {
  it('stops a real process through the pinned first-party Tool signal and joins its close before terminal cancellation', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const sandbox = new HostProcessSandbox();
    const registrations = createWorkspaceAgentToolRegistrations(new Map([['src', { rootPath: root, access: 'write' as const }]]),
      () => sandbox as unknown as AgentProcessSandbox);
    const catalog = compileTrustedAgentToolCatalog({ catalogId: 'cancel-process-catalog', revision: 1,
      tools: registrations.filter(tool => tool.document.toolName === 'workspace.run_command') });
    const entry = catalog.entries[0]!;
    const binding = { ...rootBinding('run-process'), capabilities: [{ capabilityId: 'workspace.shell', scopeIds: ['src'] }],
      toolCatalog: { catalogId: catalog.catalogId, revision: catalog.revision, digest: catalog.catalogDigest, allowedToolNames: ['workspace.run_command'] } };
    const commands = new AgentRunCommandService(unit);
    await commands.execute({ kind: 'run.start', commandId: 'process-start', runId: 'run-process', occurredAt: at(0), binding }, { turnInputPayloads: [], effectPayloads: [] });
    await commands.execute({ kind: 'run.begin', commandId: 'process-begin', runId: 'run-process', expectedVersion: 1,
      occurredAt: at(1) }, checkpoint(1, at(1), 'running'));
    const input = { command: process.execPath, args: ['-e', "require('node:fs').writeFileSync('process-ready',String(process.pid)); setInterval(()=>{},1000);"] };
    const inputDigest = new Sha256AgentEffectInputDigester().digest(input, { runId: 'run-process', effectId: 'process-effect' });
    await commands.execute({ kind: 'run.register_effect', commandId: 'process-register', runId: 'run-process', expectedVersion: 2, occurredAt: at(2),
      effect: { effectId: 'process-effect', toolCallId: 'process-call', idempotencyKey: 'process-call-key', tool: entry.tool,
        capabilityIds: ['workspace.shell'], scope: ['src'], inputDigest }
    }, { ...checkpoint(2, at(2), 'intended'), effectPayloads: [{ kind: 'record_input', effectId: 'process-effect', inputDigest, input, recordedAt: at(2) }] });
    await commands.execute({ kind: 'run.authorize_effect', commandId: 'process-authorize', runId: 'run-process', expectedVersion: 3,
      occurredAt: at(3), effectId: 'process-effect' }, checkpoint(3, at(3), 'authorized'));
    const dispatcher = new AgentEffectDispatchService(unit, unit, new ImmutableAgentToolCatalogRegistry([catalog]), new V3AgentEffectDispatchCheckpointFactory(), { now: () => at(6) });
    const operation = dispatcher.dispatch({ commandId: 'process-dispatch', runId: 'run-process', expectedVersion: 4,
      occurredAt: at(4), effectId: 'process-effect' });
    const service = new AgentRunCancellationService(unit, { effects: dispatcher,
      executionScheduler: { cancelActiveRun: async () => ({ status: 'not_active' as const }) },
      runWorkScheduler: { interruptActiveTurn: async () => ({ status: 'not_active' as const }) } });
    const shutdown = createShutdownContext(Date.now() + 10_000);
    try {
      await vi.waitFor(() => expect(existsSync(path.join(root, 'process-ready'))).toBe(true), { timeout: 5_000 });
      const pid = Number(readFileSync(path.join(root, 'process-ready'), 'utf8'));
      expect((await unit.transaction(tx => tx.loadRun('run-process')))?.effects[0]?.state.status).toBe('started');
      await expect(service.cancel('process-stop', { kind: 'agent.run.cancel', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        runId: 'run-process', expectedVersion: 5, occurredAt: at(5), reason: 'user_requested' })).resolves.toMatchObject({ status: 'requested' });
      await service.start(() => undefined);
      await expect(operation).resolves.toMatchObject({ status: 'succeeded' });
      // runFile settles on the OS close event. Its known exit result is retained even when the Run is cancelled.
      const run = await unit.transaction(tx => tx.loadRun('run-process'));
      expect(run?.state.status).toBe('cancelled');
      expect(run?.effects[0]?.state.status).toBe('succeeded');
      const material = await unit.loadProtectedEffectResultAuthority('run-process', 'process-effect');
      expect(material.result).toMatchObject({ timedOut: false, isolation: { backend: 'host-process', enforced: false } });
      expect(() => process.kill(pid, 0)).toThrow();
      service.assertHealthy();
    } finally { await service.prepareShutdown(shutdown); await operation; shutdown.dispose(); }
  });
  it.each(['succeeded', 'uncertain'] as const)('durably requests leaf cancellation, joins the Tool %s result and replays the original public receipt after reopen', async outcome => {
    const root = createRoot();
    let unit = openUnit(root);
    const input = await startAuthorizedLeafEffect(unit);
    let abort!: () => void;
    let finish!: () => void;
    const aborted = new Promise<void>(resolve => { abort = resolve; });
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const executor = { execute: vi.fn(async (_request, signal: AbortSignal) => {
      signal.addEventListener('abort', abort, { once: true });
      await finished;
      return outcome === 'succeeded' ? { status: 'succeeded' as const, result: { read: true } }
        : { status: 'uncertain' as const, reason: 'tool_stop_outcome_unknown' };
    }) };
    const dispatcher = new AgentEffectDispatchService(unit, unit, executor, new V3AgentEffectDispatchCheckpointFactory(), { now: () => at(20) });
    const operation = dispatcher.dispatch({ commandId: 'dispatch-leaf', runId: 'run-leaf', effectId: 'effect-leaf', expectedVersion: 4, occurredAt: at(4) });
    await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledOnce());
    const commands = new AgentRunCommandService(unit);
    for (let index = 0; index < 4; index += 1) {
      await commands.execute({ kind: 'run.enqueue_inbox_input', commandId: `leaf-inbox-${index}`, runId: 'run-leaf', expectedVersion: 5 + index,
        occurredAt: at(5 + index), input: { inputId: `input-${index}`, messageId: `inbox-message-${index}`, delivery: 'next_step',
          content: `leaf-input-${index}`, contentDigest: `sha256:${String(index).repeat(64)}` }
      }, { turnInputPayloads: [], effectPayloads: [] });
    }
    const service = new AgentRunCancellationService(unit, { effects: dispatcher,
      executionScheduler: { cancelActiveRun: async () => ({ status: 'not_active' as const }) },
      runWorkScheduler: { interruptActiveTurn: async () => ({ status: 'not_active' as const }) } });
    const publicOwner = createAgentRunControlComponent({ unitOfWork: unit, wakeProjectionDrain: () => undefined,
      executionPipeline: { cancellations: service, runWorkScheduler: { wake: () => undefined } } as never });
    const envelope = { commandId: 'leaf-public-stop', correlationId: 'leaf-public-stop', deadlineAt: at(60), signal: new AbortController().signal,
      command: { kind: 'agent.run.cancel' as const, contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        runId: 'run-leaf', expectedVersion: 9, occurredAt: at(9), reason: 'user_requested' as const } };
    const projection = new SqlitePublicProjectionStore(root);
    const publisher = new AgentRunPublicProjectionPublisher(unit, unit, projection);
    const shutdown = createShutdownContext(Date.now() + 5_000);
    let starting: Promise<void> | undefined;
    try {
      const accepted = await publicOwner.executeCancellation(envelope, envelope.command);
      expect(accepted).toMatchObject({ outcome: { ok: true, result: { kind: 'agent.run.cancellation.requested', runVersion: 10 } } });
      await publisher.publishPending();
      expect((await runSummaries(projection)).find(run => run.runId === 'run-leaf')).toMatchObject({ status: 'cancelling', version: 10, cancellationPending: true });
      starting = service.start(() => undefined);
      await aborted;
      expect((await unit.transaction(tx => tx.loadRun('run-leaf')))?.effects[0]?.state.status).toBe('started');
      finish();
      await expect(operation).resolves.toMatchObject({ status: outcome, run: { version: 11 } });
      await starting;
      const run = await unit.transaction(tx => tx.loadRun('run-leaf'));
      expect(run?.state.status).toBe(outcome === 'succeeded' ? 'cancelled' : 'recovering');
      expect(run?.inbox.map(value => value.content)).toEqual(['leaf-input-0', 'leaf-input-1', 'leaf-input-2', 'leaf-input-3']);
      expect((await unit.loadEffectExecutionInput('run-leaf', 'effect-leaf')).input).toEqual(input.input);
      await publisher.publishPending();
      expect((await runSummaries(projection)).find(value => value.runId === 'run-leaf')?.status).toBe(outcome === 'succeeded' ? 'cancelled' : 'interrupted');
      expect((await runSummaries(projection)).find(value => value.runId === 'run-leaf')?.cancellationPending).toBe(outcome === 'succeeded' ? undefined : true);
      service.assertHealthy();
      await service.prepareShutdown(shutdown);
      await projection.close(shutdown);
      await closeUnit(unit);
      unit = openUnit(root);
      const reopened = new AgentRunCancellationService(unit);
      expect(await reopened.cancel(envelope.commandId, envelope.command)).toEqual({ status: 'requested', runId: 'run-leaf', runVersion: 10 });
      if (outcome === 'uncertain') {
        await reopened.start(() => undefined);
        expect((await unit.transaction(tx => tx.loadRun('run-leaf')))?.state.status).toBe('recovering');
        await reopened.prepareShutdown(shutdown);
        const state = (await unit.transaction(tx => tx.loadRun('run-leaf')))!.state;
        if (state.status !== 'recovering' || state.reason !== 'uncertain_effect') throw new Error('expected Effect recovery');
        await new AgentRunCommandService(unit).execute({ kind: 'run.resolve_decision', commandId: 'explicit-effect-abandon', runId: 'run-leaf',
          expectedVersion: 11, occurredAt: at(21), resolution: { kind: 'recovery', decisionId: state.decision.decisionId,
            checkpoint: state.decision.checkpoint, resolvedAt: at(21), effectId: 'effect-leaf', outcome: 'cancel_run' }
        }, { turnInputPayloads: [], effectPayloads: [] });
        expect((await unit.transaction(tx => tx.loadRun('run-leaf')))?.state.status).toBe('cancelled');
      }
    } finally { finish(); await operation; await starting; await service.prepareShutdown(shutdown); await projection.close(shutdown); shutdown.dispose(); }
  });

  it('recovers a leaf stop intent after process ownership is lost without re-executing the Effect', async () => {
    const root = createRoot();
    let unit = openUnit(root);
    await startAuthorizedLeafEffect(unit);
    await new AgentRunCommandService(unit).execute({ kind: 'run.start_effect', commandId: 'lost-leaf-start', runId: 'run-leaf',
      expectedVersion: 4, occurredAt: at(4), effectId: 'effect-leaf' }, checkpoint(4, at(4), 'started'));
    await new AgentRunCancellationService(unit).cancel('lost-leaf-stop', { kind: 'agent.run.cancel', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
      runId: 'run-leaf', expectedVersion: 5, occurredAt: at(5), reason: 'user_requested' });
    await closeUnit(unit);
    unit = openUnit(root);
    const service = new AgentRunCancellationService(unit);
    const shutdown = createShutdownContext(Date.now() + 5_000);
    try {
      await service.start(() => undefined);
      const recovery = (await unit.listActiveRuns({ limit: 10 })).items[0]!;
      expect(recovery.ready).toBe(true);
      await new AgentStartedWorkRecoveryCoordinator(unit).recover({ kind: 'recovery_uncertain_effect', runId: recovery.run.runId,
        expectedVersion: recovery.run.version, checkpointVersion: recovery.run.state.checkpointVersion,
        effectId: 'effect-leaf', toolCallId: 'leaf-call', effectAttempt: 1,
        sourceTurnId: null, sourceAttemptId: null, sourceDirectiveDigest: null }, new AbortController().signal);
      service.wake();
      await vi.waitFor(async () => expect((await unit.transaction(tx => tx.loadRun('run-leaf')))?.state).toMatchObject({ status: 'recovering', reason: 'uncertain_effect' }));
      service.assertHealthy();
      expect((await unit.transaction(tx => tx.loadRun('run-leaf')))?.cancellationRequest?.commandId).toBe('lost-leaf-stop');
    } finally { await service.prepareShutdown(shutdown); shutdown.dispose(); }
  });
  it.each([false, true])('fences a required-child Tool before external I/O and joins an already-started Tool %s', async alreadyStarted => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const children = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');
    const objective = { task: 'tool cancellation fence' };
    await children.delegateChildren({ kind: 'control.children.delegate', commandId: 'delegate-tool', runId: 'run-parent',
      expectedVersion: 2, occurredAt: at(2), children: [{ runId: 'run-child', delegationId: 'delegation-tool',
        binding: await childBinding('run-parent', 'run-child', 'delegation-tool', objective, budget(2, 2, 2, 0, 0, 100)), objective, required: true }] });
    await commands.execute({ kind: 'run.begin', commandId: 'begin-tool-child', runId: 'run-child', expectedVersion: 1,
      occurredAt: at(3) }, checkpoint(1, at(3), 'running'));
    const input = { path: 'src/read.txt' };
    const inputDigest = new Sha256AgentEffectInputDigester().digest(input, { runId: 'run-child', effectId: 'effect-child' });
    await commands.execute({ kind: 'run.register_effect', commandId: 'register-tool', runId: 'run-child', expectedVersion: 2,
      occurredAt: at(4), effect: { effectId: 'effect-child', toolCallId: 'tool-call-child', idempotencyKey: 'run-child:tool-call-child',
        tool: { catalogId: 'catalog-test', revision: 1, digest: `sha256:${'3'.repeat(64)}`, toolName: 'workspace.read',
          toolVersion: '1.0.0', providerId: 'ariadne.builtin', contractDigest: `sha256:${'4'.repeat(64)}` },
        capabilityIds: ['workspace.read'], scope: ['src'], inputDigest }
    }, { ...checkpoint(2, at(4), 'intended'), effectPayloads: [{ kind: 'record_input', effectId: 'effect-child', inputDigest, input, recordedAt: at(4) }] });
    await commands.execute({ kind: 'run.authorize_effect', commandId: 'authorize-tool', runId: 'run-child', expectedVersion: 3,
      occurredAt: at(5), effectId: 'effect-child' }, checkpoint(3, at(5), 'authorized'));
    let finish!: () => void;
    const result = new Promise<void>(resolve => { finish = resolve; });
    const executor = { execute: vi.fn(async () => { await result; return { status: 'succeeded' as const, result: { read: true } }; }) };
    const dispatcher = new AgentEffectDispatchService(unit, unit, executor, new V3AgentEffectDispatchCheckpointFactory(), { now: () => at(9) });
    const dispatch = () => dispatcher.dispatch({ commandId: 'dispatch-tool', runId: 'run-child', effectId: 'effect-child', expectedVersion: 4,
      occurredAt: at(6) });
    const active = alreadyStarted ? dispatch() : null;
    if (active !== null) await vi.waitFor(() => expect(executor.execute).toHaveBeenCalledOnce());
    const service = new AgentRunCancellationService(unit);
    const shutdown = createShutdownContext(Date.now() + 5_000);
    try {
      expect(await service.cancel('cancel-tool-parent', { kind: 'agent.run.cancel', contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION,
        runId: 'run-parent', expectedVersion: 3, occurredAt: at(7), reason: 'user_requested' })).toMatchObject({ status: 'requested' });
      if (active === null) {
        await expect(dispatch()).rejects.toBeInstanceOf(AgentRunAncestorCancellationError);
        expect(executor.execute).not.toHaveBeenCalled();
        expect(await unit.loadCommittedCommandReceipt('dispatch-tool')).toBeNull();
      }
      await service.start(() => undefined);
      if (active !== null) {
        expect((await unit.transaction(tx => tx.loadRun('run-child')))?.state.status).toBe('running');
        expect((await unit.transaction(tx => tx.loadRun('run-parent')))?.state.status).toBe('cancelling');
        finish();
        await expect(active).resolves.toMatchObject({ status: 'succeeded' });
        service.wake();
      }
      await vi.waitFor(async () => expect((await unit.transaction(tx => tx.loadRun('run-child')))?.state.status).toBe('cancelled'));
      expect((await unit.transaction(tx => tx.loadRun('run-child')))?.effects[0]?.state.status).toBe(alreadyStarted ? 'succeeded' : 'cancelled');
      service.assertHealthy();
    } finally { finish(); await active; await service.prepareShutdown(shutdown); shutdown.dispose(); }
  });
  it('recovers a public parent cancellation after reopen, joins required descendants and publishes the exact terminal event', async () => {
    const root = createRoot();
    let unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const children = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');
    const objective = { task: 'required child' };
    const binding = await childBinding('run-parent', 'run-child', 'delegation-child', objective, budget(3, 3, 3, 0, 0, 300));
    await children.delegateChildren({ kind: 'control.children.delegate', commandId: 'delegate-parent',
      runId: 'run-parent', expectedVersion: 2, occurredAt: at(2), children: [
        { delegationId: 'delegation-child', runId: 'run-child', binding, objective, required: true },
        { delegationId: 'delegation-optional', runId: 'run-optional',
          binding: await childBinding('run-parent', 'run-optional', 'delegation-optional', objective, budget(1, 1, 1, 0, 0, 100)),
          objective, required: false }
      ] });
    await commands.execute({ kind: 'run.begin', commandId: 'begin-child', runId: 'run-child', expectedVersion: 1,
      occurredAt: at(3) }, checkpoint(1, at(3), 'child-running'));
    await children.delegateChildren({ kind: 'control.children.delegate', commandId: 'delegate-grandchild',
      runId: 'run-child', expectedVersion: 2, occurredAt: at(4), children: [{ delegationId: 'delegation-grandchild',
        runId: 'run-grandchild', binding: await childBinding('run-child', 'run-grandchild', 'delegation-grandchild',
          objective, budget(1, 1, 1, 0, 0, 100), binding), objective, required: true }] });
    const envelope = { commandId: 'public-parent-cancel', correlationId: 'public-parent-cancel',
      deadlineAt: at(60), signal: new AbortController().signal, command: { kind: 'agent.run.cancel' as const,
        contractVersion: PUBLIC_PROJECTION_CONTRACT_VERSION, runId: 'run-parent', expectedVersion: 3,
        occurredAt: at(5), reason: 'user_requested' as const } };
    const publicOwner = createAgentRunControlComponent({ unitOfWork: unit, wakeProjectionDrain: () => undefined });
    const accepted = await publicOwner.executeCancellation(envelope, envelope.command);
    expect(accepted).toMatchObject({ outcome: { ok: true, result: { kind: 'agent.run.cancellation.requested', runVersion: 4 } } });
    expect(await publicOwner.executeCancellation(envelope, envelope.command)).toEqual(accepted);
    expect((await unit.transaction(tx => tx.loadRun('run-child')))?.state.status).toBe('waiting_children');
    await closeUnit(unit);
    unit = openUnit(root);
    const service = new AgentRunCancellationService(unit);
    const projection = new SqlitePublicProjectionStore(root);
    const observer = new AgentChildTerminalObservationCoordinator(unit);
    const parentTerminals: string[] = [];
    const publisher = new AgentRunPublicProjectionPublisher(unit, unit, projection, { terminalResultSink: {
      projectTerminalResult: async request => {
        if (request.run.binding.objectiveRef.kind === 'parent_delegation') await observer.observeTerminalChild(request);
        else parentTerminals.push(request.sourceRunEventId);
      }
    } });
    const shutdown = createShutdownContext(Date.now() + 5_000);
    try {
      await service.start(() => undefined);
      await publisher.publishPending();
      await vi.waitFor(async () => {
        service.wake();
        await publisher.publishPending();
        expect((await unit.transaction(tx => tx.loadRun('run-parent')))?.state.status).toBe('cancelled');
        expect((await runSummaries(projection)).find(run => run.runId === 'run-parent')?.status).toBe('cancelled');
      }, { timeout: 3_000 });
      service.assertHealthy();
      expect(parentTerminals).toHaveLength(1);
      expect((await unit.transaction(tx => tx.loadRun('run-child')))?.state.status).toBe('cancelled');
      expect((await unit.transaction(tx => tx.loadRun('run-grandchild')))?.state.status).toBe('cancelled');
      expect((await unit.transaction(tx => tx.loadRun('run-optional')))?.state.status).toBe('queued');
      expect((await unit.transaction(tx => tx.loadDelegationByChild?.('run-optional')))?.terminal).toBeNull();
      expect((await unit.transaction(tx => tx.loadBudgetSnapshot?.('grant-run-parent')))?.openReservations).toEqual([]);
      const replayOwner = createAgentRunControlComponent({ unitOfWork: unit, wakeProjectionDrain: () => undefined });
      expect(await replayOwner.executeCancellation(envelope, envelope.command)).toEqual(accepted);
    } finally {
      await service.prepareShutdown(shutdown);
      await projection.close();
      shutdown.dispose();
    }
  });

  it.each([false, true])('fences required-child external starts with already-started inference %s, while allowing detached optional work', async alreadyStarted => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const children = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');
    const objective = { task: 'inference fence' };
    const bindings = await Promise.all(['required', 'optional'].map(kind =>
      childBinding('run-parent', `run-${kind}`, `delegation-${kind}`, objective, budget(2, 2, 2, 0, 0, 100))));
    await children.delegateChildren({ kind: 'control.children.delegate', commandId: 'delegate-fence', runId: 'run-parent',
      expectedVersion: 2, occurredAt: at(2), children: bindings.map((binding, index) => ({
        delegationId: index === 0 ? 'delegation-required' : 'delegation-optional', runId: index === 0 ? 'run-required' : 'run-optional',
        binding, objective, required: index === 0
      })).sort((left, right) => left.runId < right.runId ? -1 : 1) });
    const payload = { messages: [{ kind: 'text' as const, role: 'user' as const, content: 'bounded child input' }],
      availableTools: [{ tool: { catalogId: 'catalog-test', revision: 1, digest: `sha256:${'3'.repeat(64)}`,
        toolName: 'workspace.read', toolVersion: '1.0.0', providerId: 'ariadne.builtin', contractDigest: `sha256:${'4'.repeat(64)}` },
        capabilityIds: ['workspace.read'] }] };
    const inputDigest = await digestAgentTurnInput(payload);
    for (const [index, binding] of bindings.entries()) {
      const runId = index === 0 ? 'run-required' : 'run-optional';
      await commands.execute({ kind: 'run.begin', commandId: `begin-${runId}`, runId, expectedVersion: 1,
        occurredAt: at(3) }, checkpoint(1, at(3), 'child-running'));
      if (binding.objectiveRef.kind !== 'parent_delegation') throw new Error('fixture_invalid');
      const cause = { kind: 'delegation_objective' as const, parentRunId: binding.objectiveRef.parentRunId,
        delegationId: binding.objectiveRef.delegationId, objectiveDigest: binding.objectiveRef.objectiveDigest };
      await commands.execute({ kind: 'run.register_turn', commandId: `register-${runId}`, runId, expectedVersion: 2,
        occurredAt: at(4), turn: { turnId: `turn-${runId}`, attemptId: `attempt-${runId}`,
          providerIdempotencyKey: `provider-${runId}`, inputDigest, inputSummary: summarizeAgentTurnInput(payload),
          cause
        } }, { ...checkpoint(2, at(4), 'intended'), turnInputPayloads: [{ turnId: `turn-${runId}`, inputDigest,
          recordedAt: at(4), payload: { format: 'ariadne.agent-turn-input', schemaVersion: 1, runId, turnId: `turn-${runId}`,
            cause, authorityRef: { ...binding.objectiveRef }, ...payload } }] });
    }
    if (alreadyStarted) await commands.execute({ kind: 'run.start_inference_attempt', commandId: 'started-before-cancel', runId: 'run-required',
      expectedVersion: 3, occurredAt: at(5), turnId: 'turn-run-required', attemptId: 'attempt-run-required'
    }, checkpoint(3, at(5), 'started'));
    await children.requestParentCancellation({ kind: 'control.children.request_parent_cancellation', commandId: 'cancel-fence',
      runId: 'run-parent', expectedVersion: 3, occurredAt: at(5), reason: 'user_requested' });
    const gate = new AgentParentCancellationGate(unit);
    const required = await unit.transaction(tx => tx.loadRun('run-required'));
    const optional = await unit.transaction(tx => tx.loadRun('run-optional'));
    if (required === null || optional === null) throw new Error('fixture_missing');
    expect(await gate.isSuppressed(required)).toBe(true);
    expect(await gate.isSuppressed(optional)).toBe(false);
    await expect(commands.execute({ kind: 'run.start_inference_attempt', commandId: 'start-required', runId: required.runId,
      expectedVersion: required.version, occurredAt: at(6), turnId: 'turn-run-required', attemptId: 'attempt-run-required'
    }, checkpoint(required.state.checkpointVersion + 1, at(6), 'started'))).rejects.toBeInstanceOf(AgentRunAncestorCancellationError);
    expect(await unit.loadCommittedCommandReceipt('start-required')).toBeNull();
    expect((await unit.transaction(tx => tx.loadRun(required.runId)))?.version).toBe(alreadyStarted ? 4 : 3);
    await expect(commands.execute({ kind: 'run.start_inference_attempt', commandId: 'start-optional', runId: optional.runId,
      expectedVersion: 3, occurredAt: at(6), turnId: 'turn-run-optional', attemptId: 'attempt-run-optional'
    }, checkpoint(3, at(6), 'started'))).resolves.toMatchObject({ run: { version: 4 } });
    if (alreadyStarted) {
      const service = new AgentRunCancellationService(unit);
      const shutdown = createShutdownContext(Date.now() + 5_000);
      try {
        await service.start(() => undefined);
        expect((await unit.transaction(tx => tx.loadRun(required.runId)))?.turns.at(-1)?.attempts.at(-1)?.state.status).toBe('started');
        service.assertHealthy();
        const work = new AgentRunWorkClassifier().classify(required);
        if (work.kind !== 'recovery_uncertain_delegated_inference') throw new Error(`fixture_classification:${work.kind}`);
        const recovery = await new AgentStartedWorkRecoveryCoordinator(unit).recover(work, new AbortController().signal);
        service.wake();
        await vi.waitFor(async () => expect((await unit.transaction(tx => tx.loadRun(required.runId)))?.state.status).toBe('cancelled'));
        const terminal = await unit.transaction(tx => tx.loadRun(required.runId));
        expect(terminal?.state).toMatchObject({ status: 'cancelled', inferenceRecovery: {
          recoveryDecisionId: recovery.recoveryDecisionId, turnId: 'turn-run-required', attemptId: 'attempt-run-required'
        } });
        service.assertHealthy();
      } finally { await service.prepareShutdown(shutdown); shutdown.dispose(); }
    }
  });
  it('retires a delegated Child through the canonical Parent terminal observation', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    const retirement = new AgentRetiredToolCatalogTerminalizationCoordinator(unit);
    await startRunningRoot(commands, 'run-retired-parent');
    const objective: AgentControlJsonValue = { task: 'retired child' };
    await control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-delegate-retired-child',
      runId: 'run-retired-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      children: [{
        delegationId: 'delegation-retired-child',
        runId: 'run-retired-child',
        binding: await childBinding(
          'run-retired-parent',
          'run-retired-child',
          'delegation-retired-child',
          objective,
          budget(2, 2, 2, 0, 0, 100)
        ),
        objective,
        required: true
      }]
    });
    await commands.execute({
      kind: 'run.begin',
      commandId: 'command-begin-retired-child',
      runId: 'run-retired-child',
      expectedVersion: 1,
      occurredAt: at(3)
    }, checkpoint(1, at(3), 'retired-child-running'));
    const child = await unit.transaction((transaction) => (
      transaction.loadRun('run-retired-child')
    ));
    if (child === null) throw new Error('retired_child_fixture_missing');

    await expect(retirement.terminalize(
      child,
      new AbortController().signal
    )).resolves.toMatchObject({
      runId: 'run-retired-child',
      runVersion: 3,
      status: 'failed',
      reason: 'tool_catalog_retired'
    });
    const parentAfterChild = await unit.transaction((transaction) => (
      transaction.loadRun('run-retired-parent')
    ));
    expect(parentAfterChild?.state.status).toBe('running');
    const delegation = await unit.transaction((transaction) => (
      transaction.loadDelegationByChild?.('run-retired-child')
    ));
    expect(delegation?.terminal).toMatchObject({
      childRunVersion: 3,
      childStatus: 'failed'
    });
    const budgetSnapshot = await unit.transaction((transaction) => (
      transaction.loadBudgetSnapshot?.('grant-run-retired-parent')
    ));
    expect(budgetSnapshot?.openReservations).toEqual([]);

    if (parentAfterChild === null) throw new Error('retired_parent_fixture_missing');
    await expect(retirement.terminalize(
      parentAfterChild,
      new AbortController().signal
    )).resolves.toMatchObject({
      runId: 'run-retired-parent',
      status: 'failed',
      errorCode: 'agent_tool_catalog_retired'
    });
  });

  it('commits exact Plan approval, durable Budget, parent plus N children, replay, and out-of-order terminal propagation', async () => {
    const root = createRoot();
    let unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');

    const planPayload: AgentControlJsonValue = {
      title: 'Safe immutable plan',
      steps: [{ id: 'step-1', action: 'inspect' }]
    };
    const planHash = await sha256AgentControlData(planPayload);
    const waiting = await control.createPlanVersionAndRequestApproval({
      kind: 'control.plan.create_and_request_approval',
      commandId: 'command-plan-create',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      decisionId: 'decision-plan-exact',
      plan: {
        ref: { planId: 'plan-parent', version: 1, contentHash: planHash },
        payload: planPayload
      }
    });
    expect(waiting.mutations[0]?.run.state).toMatchObject({
      status: 'waiting',
      reason: 'plan_approval',
      checkpointVersion: 2
    });
    const approved = await control.approvePlan({
      kind: 'control.plan.approve',
      commandId: 'command-plan-approve',
      runId: 'run-parent',
      expectedVersion: 3,
      occurredAt: at(3),
      approvalId: 'approval-plan-exact',
      decisionId: 'decision-plan-exact',
      checkpointVersion: 2,
      plan: { planId: 'plan-parent', version: 1, contentHash: planHash }
    });
    expect(approved.mutations[0]?.run.state.status).toBe('running');

    await control.reserveBudget({
      kind: 'control.budget.reserve',
      commandId: 'command-budget-reserve',
      runId: 'run-parent',
      expectedVersion: 4,
      occurredAt: at(4),
      entryId: 'budget-entry-reserve-one',
      reservationId: 'reservation-one',
      vector: budget(1, 1, 1, 0, 0, 100)
    });
    await control.settleBudget({
      kind: 'control.budget.settle',
      commandId: 'command-budget-settle',
      runId: 'run-parent',
      expectedVersion: 5,
      occurredAt: at(5),
      entryId: 'budget-entry-settle-one',
      reservationId: 'reservation-one',
      actual: budget(1, 1, 1, 0, 0, 80)
    });

    const objectiveA: AgentControlJsonValue = {
      task: 'inspect child A',
      path: 'src/private/a.ts'
    };
    const objectiveB: AgentControlJsonValue = {
      task: 'inspect child B',
      path: 'src/private/b.ts'
    };
    const delegationCommand = {
      kind: 'control.children.delegate' as const,
      commandId: 'command-delegate-two',
      runId: 'run-parent',
      expectedVersion: 6,
      occurredAt: at(6),
      children: [
        {
          delegationId: 'delegation-a',
          runId: 'run-child-a',
          binding: await childBinding(
            'run-parent',
            'run-child-a',
            'delegation-a',
            objectiveA,
            budget(2, 2, 2, 0, 0, 200)
          ),
          objective: objectiveA,
          required: true
        },
        {
          delegationId: 'delegation-b',
          runId: 'run-child-b',
          binding: await childBinding(
            'run-parent',
            'run-child-b',
            'delegation-b',
            objectiveB,
            budget(2, 2, 2, 0, 0, 200)
          ),
          objective: objectiveB,
          required: true
        }
      ]
    };
    const delegated = await control.delegateChildren(delegationCommand);
    expect(delegated.mutations.map((item) => item.runId)).toEqual([
      'run-child-a',
      'run-child-b',
      'run-parent'
    ]);
    expect(delegated.mutations.find((item) => item.runId === 'run-parent')?.run.state)
      .toMatchObject({
        status: 'waiting_children',
        requiredChildRunIds: ['run-child-a', 'run-child-b'],
        terminalChildRunIds: []
      });

    await closeUnit(unit);
    unit = openUnit(root);
    const reopenedControl = new AgentPlanBudgetChildRunService(unit);
    const replay = await reopenedControl.delegateChildren(delegationCommand);
    expect(replay.replayed).toBe(true);
    expect(replay.mutations).toHaveLength(3);

    const childCommands = new AgentRunCommandService(unit);
    await completeQueuedChild(childCommands, 'run-child-a', 7);
    await completeQueuedChild(childCommands, 'run-child-b', 9);

    const observedB = await reopenedControl.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId: 'command-observe-child-b',
      runId: 'run-parent',
      expectedVersion: 7,
      occurredAt: at(11),
      childRunId: 'run-child-b',
      childRunVersion: 3,
      childStatus: 'completed'
    });
    expect(observedB.mutations[0]?.run.state).toMatchObject({
      status: 'waiting_children',
      terminalChildRunIds: ['run-child-b']
    });
    const observedA = await reopenedControl.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId: 'command-observe-child-a',
      runId: 'run-parent',
      expectedVersion: 8,
      occurredAt: at(12),
      childRunId: 'run-child-a',
      childRunVersion: 3,
      childStatus: 'completed'
    });
    expect(observedA.mutations[0]?.run.state.status).toBe('running');

    const duplicate = await reopenedControl.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId: 'command-observe-child-a-duplicate',
      runId: 'run-parent',
      expectedVersion: 8,
      occurredAt: at(13),
      childRunId: 'run-child-a',
      childRunVersion: 3,
      childStatus: 'completed'
    });
    expect(duplicate).toMatchObject({ idempotent: true, replayed: false });

    const snapshot = await unit.transaction((transaction) =>
      transaction.loadBudgetSnapshot?.('grant-run-parent')
    );
    expect(snapshot?.openReservations).toEqual([]);
    expect(snapshot?.available).toEqual(
      budget(11, 7, 7, 4, 2, 999_920)
    );

    const database = new DatabaseSync(resolveAgentControlDatabasePath(root), {
      readOnly: true
    });
    try {
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(count(database, 'agent_plan_versions')).toBe(1);
      expect(count(database, 'agent_plan_approvals')).toBe(1);
      expect(count(database, 'agent_delegations')).toBe(2);
      expect(count(database, 'agent_child_terminals')).toBe(2);
      expect(count(database, 'agent_budget_grants')).toBe(3);
      const publicText = readPublicAuthorityText(database);
      expect(publicText).not.toContain('inspect child A');
      expect(publicText).not.toContain('src/private/a.ts');
      expect(publicText).not.toContain('inspect child B');
    } finally {
      database.close();
    }
  });

  it('serializes sibling allocation and reservations without overdraw', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');

    const objectiveA: AgentControlJsonValue = { task: 'overallocate A' };
    const objectiveB: AgentControlJsonValue = { task: 'overallocate B' };
    await expect(control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-overallocate-siblings',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      children: [
        {
          delegationId: 'delegation-over-a',
          runId: 'run-over-a',
          binding: await childBinding(
            'run-parent', 'run-over-a', 'delegation-over-a', objectiveA,
            budget(8, 5, 5, 3, 2, 700_000)
          ),
          objective: objectiveA,
          required: true
        },
        {
          delegationId: 'delegation-over-b',
          runId: 'run-over-b',
          binding: await childBinding(
            'run-parent', 'run-over-b', 'delegation-over-b', objectiveB,
            budget(8, 5, 5, 3, 2, 700_000)
          ),
          objective: objectiveB,
          required: true
        }
      ]
    })).rejects.toThrow(/exceed.*Budget balance/i);

    const reservationA = {
      kind: 'control.budget.reserve',
      commandId: 'command-reserve-concurrent-a',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      entryId: 'budget-entry-concurrent-a',
      reservationId: 'reservation-concurrent-a',
      vector: budget(8, 5, 5, 3, 2, 700_000)
    } as const;
    const first = control.reserveBudget(reservationA);
    const second = control.reserveBudget({
      kind: 'control.budget.reserve',
      commandId: 'command-reserve-concurrent-b',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      entryId: 'budget-entry-concurrent-b',
      reservationId: 'reservation-concurrent-b',
      vector: budget(8, 5, 5, 3, 2, 700_000)
    });
    const settled = await Promise.allSettled([first, second]);
    expect(settled.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((item) => item.status === 'rejected')).toHaveLength(1);
    if (settled[0]?.status === 'fulfilled') {
      await expect(control.reserveBudget(reservationA)).resolves.toMatchObject({
        replayed: true
      });
    }

    const snapshot = await unit.transaction((transaction) =>
      transaction.loadBudgetSnapshot?.('grant-run-parent')
    );
    expect(snapshot?.openReservations).toHaveLength(1);
    expect(snapshot?.available).toEqual(budget(4, 3, 3, 1, 0, 300_000));

    const database = new DatabaseSync(resolveAgentControlDatabasePath(root), {
      readOnly: true
    });
    try {
      expect(count(database, 'agent_delegations')).toBe(0);
      expect(count(database, 'agent_budget_entries')).toBe(2);
      expect(count(database, 'agent_commands')).toBe(3);
      expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('rejects child escalation and keeps a cancelling parent non-terminal until its required child is terminal', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');
    const objective: AgentControlJsonValue = { task: 'read only child' };
    const baseBinding = await childBinding(
      'run-parent',
      'run-child-a',
      'delegation-a',
      objective,
      budget(2, 2, 2, 0, 0, 100)
    );
    const binding: AgentRunBinding = {
      ...baseBinding,
      workspace: {
        ...baseBinding.workspace,
        access: 'read'
      }
    };
    await control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-delegate-cancel-child',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      children: [{
        delegationId: 'delegation-a',
        runId: 'run-child-a',
        binding,
        objective,
        required: true
      }]
    });
    await commands.execute({
      kind: 'run.begin',
      commandId: 'command-begin-child-a',
      runId: 'run-child-a',
      expectedVersion: 1,
      occurredAt: at(3)
    }, checkpoint(1, at(3), 'child-running'));

    const grandchildObjective: AgentControlJsonValue = { task: 'write escalation' };
    const baseEscalated = await childBinding(
      'run-child-a',
      'run-grandchild',
      'delegation-grandchild',
      grandchildObjective,
      budget(1, 1, 1, 0, 0, 10),
      binding
    );
    const escalated: AgentRunBinding = {
      ...baseEscalated,
      workspace: {
        ...baseEscalated.workspace,
        access: 'write'
      }
    };
    await expect(control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-grandchild-escalation',
      runId: 'run-child-a',
      expectedVersion: 2,
      occurredAt: at(4),
      children: [{
        delegationId: 'delegation-grandchild',
        runId: 'run-grandchild',
        binding: escalated,
        objective: grandchildObjective,
        required: true
      }]
    })).rejects.toThrow(/cannot expand workspace access/i);

    const cancelling = await control.requestParentCancellation({
      kind: 'control.children.request_parent_cancellation',
      commandId: 'command-cancel-parent',
      runId: 'run-parent',
      expectedVersion: 3,
      occurredAt: at(5),
      reason: 'user_cancelled_parent'
    });
    expect(cancelling.mutations[0]?.run.state.status).toBe('cancelling');
    await expect(commands.execute({
      kind: 'run.cancel',
      commandId: 'command-bypass-parent-cancel',
      runId: 'run-parent',
      expectedVersion: 4,
      occurredAt: at(6),
      reason: 'bypass'
    }, { turnInputPayloads: [], effectPayloads: [] })).rejects.toThrow(/child Runs/);
    await expect(control.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId: 'command-observe-nonterminal-child',
      runId: 'run-parent',
      expectedVersion: 4,
      occurredAt: at(6),
      childRunId: 'run-child-a',
      childRunVersion: 2,
      childStatus: 'completed'
    })).rejects.toThrow(/exact durable terminal child/);

    await commands.execute({
      kind: 'run.complete',
      commandId: 'command-complete-child-a',
      runId: 'run-child-a',
      expectedVersion: 2,
      occurredAt: at(7)
    }, { turnInputPayloads: [], effectPayloads: [] });
    const cancelled = await control.observeChildTerminal({
      kind: 'control.children.observe_terminal',
      commandId: 'command-observe-terminal-child',
      runId: 'run-parent',
      expectedVersion: 4,
      occurredAt: at(8),
      childRunId: 'run-child-a',
      childRunVersion: 3,
      childStatus: 'completed'
    });
    expect(cancelled.mutations[0]?.run.state).toMatchObject({
      status: 'cancelled',
      reason: 'user_cancelled_parent'
    });
    expect(cancelled.mutations[0]?.events.filter(event => event.payload.type === 'run.cancelled')).toHaveLength(1);
  });

  it('rolls back parent, children, allocations, objectives, Events, and Outbox when a side-fact insert is killed', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');
    const database = databaseOf(unit);
    database.exec(`
      CREATE TRIGGER kill_delegation_fact
      BEFORE INSERT ON agent_delegations
      BEGIN
        SELECT RAISE(ABORT, 'kill_delegation_fact');
      END;
    `);
    const objective: AgentControlJsonValue = { task: 'must roll back' };
    await expect(control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-delegate-killed',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      children: [{
        delegationId: 'delegation-killed',
        runId: 'run-child-killed',
        binding: await childBinding(
          'run-parent',
          'run-child-killed',
          'delegation-killed',
          objective,
          budget(1, 1, 1, 0, 0, 10)
        ),
        objective,
        required: true
      }]
    })).rejects.toThrow(/kill_delegation_fact/);
    database.exec('DROP TRIGGER kill_delegation_fact');

    const parent = await unit.transaction((transaction) => transaction.loadRun('run-parent'));
    expect(parent).toMatchObject({ version: 2, state: { status: 'running' } });
    expect(await unit.transaction((transaction) => transaction.loadRun('run-child-killed')))
      .toBeNull();
    for (const table of [
      'agent_delegations',
      'agent_child_terminals',
      'agent_plan_versions'
    ]) {
      expect(count(database, table)).toBe(0);
    }
    expect(countWhere(database, 'agent_commands', 'command_id', 'command-delegate-killed'))
      .toBe(0);
    expect(countWhere(database, 'agent_events', 'command_id', 'command-delegate-killed'))
      .toBe(0);
    expect(countWhere(database, 'agent_outbox', 'command_id', 'command-delegate-killed'))
      .toBe(0);
    expect(count(database, 'agent_budget_grants')).toBe(1);
    expect(count(database, 'agent_budget_entries')).toBe(1);
  });

  it('fails recovery and approval closed when an exact protected Plan is missing and rejects credential payloads before any write', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-parent');

    const unsafePayload: AgentControlJsonValue = {
      apiToken: 'sk-this-credential-must-never-be-written'
    };
    const unsafeHash = await sha256AgentControlData(unsafePayload);
    await expect(control.createPlanVersionAndRequestApproval({
      kind: 'control.plan.create_and_request_approval',
      commandId: 'command-plan-credential-rejected',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      decisionId: 'decision-plan-credential-rejected',
      plan: {
        ref: { planId: 'plan-unsafe', version: 1, contentHash: unsafeHash },
        payload: unsafePayload
      }
    })).rejects.toThrow(/credentials|authorization/i);
    expect(await unit.transaction((transaction) => transaction.loadRun('run-parent')))
      .toMatchObject({ version: 2, state: { status: 'running' } });

    const payload: AgentControlJsonValue = { title: 'recoverable plan', steps: [] };
    const contentHash = await sha256AgentControlData(payload);
    await control.createPlanVersionAndRequestApproval({
      kind: 'control.plan.create_and_request_approval',
      commandId: 'command-plan-before-missing',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(3),
      decisionId: 'decision-plan-before-missing',
      plan: {
        ref: { planId: 'plan-missing', version: 1, contentHash },
        payload
      }
    });
    const database = databaseOf(unit);
    database.prepare(
      'DELETE FROM agent_plan_versions WHERE plan_id=? AND plan_version=?'
    ).run('plan-missing', 1);

    const recovery = await unit.listActiveRuns();
    const blocked = recovery.items.find((item) => item.run.runId === 'run-parent');
    expect(blocked).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(['missing_plan_payload'])
    });
    await expect(control.approvePlan({
      kind: 'control.plan.approve',
      commandId: 'command-approve-missing-plan',
      runId: 'run-parent',
      expectedVersion: 3,
      occurredAt: at(4),
      approvalId: 'approval-missing-plan',
      decisionId: 'decision-plan-before-missing',
      checkpointVersion: 2,
      plan: { planId: 'plan-missing', version: 1, contentHash }
    })).rejects.toThrow(/exact intact protected Plan/i);
    expect(countWhere(
      database,
      'agent_commands',
      'command_id',
      'command-approve-missing-plan'
    )).toBe(0);
    expect(readAllDatabaseText(database)).not.toContain(
      'sk-this-credential-must-never-be-written'
    );
  });

  it('reports durable Budget and Delegation integrity failures during active recovery', async () => {
    const root = createRoot();
    const unit = openUnit(root);
    const commands = new AgentRunCommandService(unit);
    const control = new AgentPlanBudgetChildRunService(unit);
    await startRunningRoot(commands, 'run-budget-corrupt');
    const database = databaseOf(unit);
    database.prepare(
      `DELETE FROM agent_budget_entries
       WHERE grant_id=? AND entry_kind='root_grant'`
    ).run('grant-run-budget-corrupt');

    await startRunningRoot(commands, 'run-parent');
    const objective: AgentControlJsonValue = { task: 'delegation integrity' };
    await control.delegateChildren({
      kind: 'control.children.delegate',
      commandId: 'command-delegate-before-corruption',
      runId: 'run-parent',
      expectedVersion: 2,
      occurredAt: at(2),
      children: [{
        delegationId: 'delegation-corrupt',
        runId: 'run-child-corrupt',
        binding: await childBinding(
          'run-parent',
          'run-child-corrupt',
          'delegation-corrupt',
          objective,
          budget(1, 1, 1, 0, 0, 10)
        ),
        objective,
        required: true
      }]
    });
    database.prepare(
      'DELETE FROM agent_delegations WHERE delegation_id=?'
    ).run('delegation-corrupt');

    const recovery = await unit.listActiveRuns({ limit: 10 });
    const budgetRun = recovery.items.find(
      (item) => item.run.runId === 'run-budget-corrupt'
    );
    const childRun = recovery.items.find(
      (item) => item.run.runId === 'run-child-corrupt'
    );
    const parentRun = recovery.items.find(
      (item) => item.run.runId === 'run-parent'
    );
    expect(budgetRun).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(['budget_integrity_mismatch'])
    });
    expect(childRun).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(['missing_delegation'])
    });
    expect(parentRun).toMatchObject({
      ready: false,
      issues: expect.arrayContaining(['pending_required_child_mismatch'])
    });
  });
});

async function startRunningRoot(
  commands: AgentRunCommandService,
  runId: string
): Promise<void> {
  await commands.execute({
    kind: 'run.start',
    commandId: `command-start-${runId}`,
    runId,
    occurredAt: at(0),
    binding: rootBinding(runId)
  }, { turnInputPayloads: [], effectPayloads: [] });
  await commands.execute({
    kind: 'run.begin',
    commandId: `command-begin-${runId}`,
    runId,
    expectedVersion: 1,
    occurredAt: at(1)
  }, checkpoint(1, at(1), 'root-running'));
}

async function completeQueuedChild(
  commands: AgentRunCommandService,
  runId: string,
  offset: number
): Promise<void> {
  await commands.execute({
    kind: 'run.begin',
    commandId: `command-begin-${runId}`,
    runId,
    expectedVersion: 1,
    occurredAt: at(offset)
  }, checkpoint(1, at(offset), 'child-running'));
  await commands.execute({
    kind: 'run.complete',
    commandId: `command-complete-${runId}`,
    runId,
    expectedVersion: 2,
    occurredAt: at(offset + 1)
  }, { turnInputPayloads: [], effectPayloads: [] });
}

async function startAuthorizedLeafEffect(unit: SqliteAgentRunUnitOfWork) {
  const commands = new AgentRunCommandService(unit);
  await startRunningRoot(commands, 'run-leaf');
  const input = { path: 'src/private.txt' };
  const inputDigest = new Sha256AgentEffectInputDigester().digest(input, { runId: 'run-leaf', effectId: 'effect-leaf' });
  await commands.execute({ kind: 'run.register_effect', commandId: 'leaf-register', runId: 'run-leaf', expectedVersion: 2, occurredAt: at(2),
    effect: { effectId: 'effect-leaf', toolCallId: 'leaf-call', idempotencyKey: 'leaf-call-key',
      tool: { catalogId: 'catalog-test', revision: 1, digest: `sha256:${'3'.repeat(64)}`, toolName: 'workspace.read', toolVersion: '1.0.0',
        providerId: 'ariadne.builtin', contractDigest: `sha256:${'4'.repeat(64)}` }, capabilityIds: ['workspace.read'], scope: ['src'], inputDigest }
  }, { ...checkpoint(2, at(2), 'intended'), effectPayloads: [{ kind: 'record_input', effectId: 'effect-leaf', inputDigest, input, recordedAt: at(2) }] });
  await commands.execute({ kind: 'run.authorize_effect', commandId: 'leaf-authorize', runId: 'run-leaf', expectedVersion: 3,
    occurredAt: at(3), effectId: 'effect-leaf' }, checkpoint(3, at(3), 'authorized'));
  return { input, inputDigest };
}

function rootBinding(runId: string): AgentRunBinding {
  return {
    bindingVersion: 3,
    sessionId: 'session-control-test',
    objectiveRef: {
      kind: 'conversation_message',
      messageId: `message-${runId}`,
      messageVersion: 1,
      contentDigest: `sha256:${'1'.repeat(64)}`
    },
    workspace: {
      workspaceId: 'workspace-control-test',
      revision: 1,
      grantDigest: `sha256:${'2'.repeat(64)}`,
      access: 'write',
      scopeIds: ['src']
    },
    model: {
      providerId: 'provider-test',
      modelId: 'model-test',
      settingsRevision: 1
    },
    policy: {
      policyId: 'policy-test',
      revision: 1,
      permissionMode: 'ask'
    },
    capabilities: [{ capabilityId: 'workspace.read', scopeIds: ['src'] }],
    toolCatalog: {
      catalogId: 'catalog-test',
      revision: 1,
      digest: `sha256:${'3'.repeat(64)}`,
      allowedToolNames: ['workspace.read']
    },
    budget: {
      grantId: `grant-${runId}`,
      runId,
      vector: budget(12, 8, 8, 4, 2, 1_000_000),
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' }
    }
  };
}

async function childBinding(
  parentRunId: string,
  runId: string,
  delegationId: string,
  objective: AgentControlJsonValue,
  vector: AgentBudgetVector,
  parent = rootBinding(parentRunId)
): Promise<AgentRunBinding> {
  return {
    ...parent,
    objectiveRef: {
      kind: 'parent_delegation',
      parentRunId,
      delegationId,
      objectiveDigest: await sha256AgentControlData(objective),
      providerId: 'ariadne.in_process',
      mode: 'one_shot'
    },
    workspace: { ...parent.workspace, scopeIds: [...parent.workspace.scopeIds] },
    capabilities: parent.capabilities.map((item) => ({
      ...item,
      scopeIds: [...item.scopeIds]
    })),
    toolCatalog: {
      ...parent.toolCatalog,
      allowedToolNames: [...parent.toolCatalog.allowedToolNames]
    },
    budget: {
      grantId: `grant-${runId}`,
      runId,
      vector,
      deadlineAt: parent.budget.deadlineAt,
      source: {
        kind: 'parent_allocation',
        parentRunId,
        parentGrantId: parent.budget.grantId,
        delegationId
      }
    }
  };
}

function budget(
  modelTurns: number,
  toolCalls: number,
  readCalls: number,
  writeCalls: number,
  shellCalls: number,
  costMicrousd: number
): AgentBudgetVector {
  return { modelTurns, toolCalls, readCalls, writeCalls, shellCalls, costMicrousd };
}

function checkpoint(
  checkpointVersion: number,
  createdAt: string,
  phase: string
): {
  readonly checkpoint: AgentRunCheckpointCommit;
  readonly turnInputPayloads: readonly [];
  readonly effectPayloads: readonly [];
} {
  return {
    checkpoint: {
      checkpointVersion,
      createdAt,
      payload: {
        format: 'ariadne.agent-checkpoint',
        schemaVersion: 1,
        engineContinuation: { phase },
        modelContext: []
      }
    },
    turnInputPayloads: [],
    effectPayloads: []
  };
}

function createRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ariadne-plan-budget-child-'));
  roots.push(root);
  return root;
}

function openUnit(root: string): SqliteAgentRunUnitOfWork {
  const unit = new SqliteAgentRunUnitOfWork(root);
  openUnits.add(unit);
  return unit;
}

async function closeUnit(unit: SqliteAgentRunUnitOfWork): Promise<void> {
  if (!openUnits.delete(unit)) return;
  const context = createShutdownContext(Date.now() + 5_000);
  try {
    await unit.close(context);
  } finally {
    context.dispose();
  }
}

function databaseOf(unit: SqliteAgentRunUnitOfWork): DatabaseSync {
  return (unit as unknown as { database: DatabaseSync }).database;
}

function count(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  }).count);
}

async function runSummaries(store: SqlitePublicProjectionStore) {
  const manifest = await store.beginCatalogSnapshot({ pageContractVersion: '3.0',
    scope: { kind: 'tasks' }, feature: 'runs', filter: 'all' });
  if ('status' in manifest) throw new Error('fixture_run_catalog_unavailable');
  const page = await store.readCatalogPage({ manifest, limit: 128 });
  if (page.status !== 'ok' || page.hasMore) throw new Error('fixture_run_catalog_incomplete');
  return page.rows.flatMap(row => row.feature === 'runs' ? [row.dto] : []);
}

function countWhere(
  database: DatabaseSync,
  table: string,
  column: string,
  value: string
): number {
  return Number((database.prepare(
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`
  ).get(value) as { count: number }).count);
}

function readPublicAuthorityText(database: DatabaseSync): string {
  const rows = database.prepare(`
    SELECT aggregate_json AS value FROM agent_runs
    UNION ALL SELECT result_run_json FROM agent_command_runs
    UNION ALL SELECT event_json FROM agent_events
    UNION ALL SELECT event_json FROM agent_outbox
  `).all() as Array<{ value: string }>;
  return rows.map((row) => row.value).join('\n');
}

function readAllDatabaseText(database: DatabaseSync): string {
  const tables = (database.prepare(
    `SELECT name FROM sqlite_master
     WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all() as Array<{ name: string }>).map((row) => row.name);
  return tables.map((table) =>
    JSON.stringify(database.prepare(`SELECT * FROM ${table}`).all())
  ).join('\n');
}

function at(offsetSeconds: number): string {
  return new Date(Date.UTC(2030, 0, 1, 0, 0, offsetSeconds)).toISOString();
}
