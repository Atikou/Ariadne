import {
  AgentRunCommandService,
  AgentRunInvariantError,
  AgentRunVersionConflictError,
  assertValidAgentRun,
  deriveStableAgentId,
  type AgentRun,
  type AgentRunCheckpointCommit,
  type AgentRunUnitOfWork
} from '@ariadne/agent-core';

import type {
  AgentRunRetiredToolCatalogTerminalizationOwner,
  AgentRunRetiredToolCatalogTerminalizationReceipt
} from '../ports/AgentRunAuthorityRetirement.js';
import {
  AgentChildTerminalObservationCoordinator
} from './AgentChildTerminalObservationCoordinator.js';

const ERROR_CODE = 'agent_tool_catalog_retired' as const;
const FAILURE_MESSAGE =
  'This Agent Run cannot resume because its immutable Tool Catalog is unavailable after a Runtime upgrade. Start a new Run to use the current Tool Catalog.';

/**
 * Durable upgrade owner for one nonterminal Run whose exact executable Tool
 * Catalog is no longer shipped. It never rebinds the Run or performs Tool or
 * Provider I/O.
 */
export class AgentRetiredToolCatalogTerminalizationCoordinator
implements AgentRunRetiredToolCatalogTerminalizationOwner {
  private readonly commands: AgentRunCommandService;
  private readonly childTerminals: AgentChildTerminalObservationCoordinator;

  public constructor(private readonly runs: AgentRunUnitOfWork) {
    this.commands = new AgentRunCommandService(runs);
    this.childTerminals = new AgentChildTerminalObservationCoordinator(runs);
  }

  public async terminalize(
    observed: AgentRun,
    signal: AbortSignal
  ): Promise<AgentRunRetiredToolCatalogTerminalizationReceipt> {
    signal.throwIfAborted();
    assertValidAgentRun(observed);
    const run = await this.runs.transaction((transaction) => (
      transaction.loadRun(observed.runId)
    ));
    if (run === null) {
      throw new AgentRunVersionConflictError(
        observed.runId,
        observed.version,
        null
      );
    }
    if (run.version !== observed.version) {
      throw new AgentRunVersionConflictError(
        run.runId,
        observed.version,
        run.version
      );
    }
    assertValidAgentRun(run);
    assertExactCatalog(run, observed);

    const catalog = run.binding.toolCatalog;
    const commandId = await deriveStableAgentId(
      'retired-tool-catalog',
      run.runId,
      catalog.catalogId,
      String(catalog.revision),
      catalog.digest
    );
    const checkpoint = terminalCheckpoint(run);

    signal.throwIfAborted();
    const committed = await this.commands.execute({
      kind: 'run.fail',
      commandId,
      runId: run.runId,
      expectedVersion: run.version,
      occurredAt: run.updatedAt,
      errorCode: ERROR_CODE,
      message: FAILURE_MESSAGE
    }, {
      checkpoint,
      turnInputPayloads: [],
      effectPayloads: []
    });
    if (
      committed.run.state.status !== 'failed'
      || committed.run.state.errorCode !== ERROR_CODE
      || committed.run.state.message !== FAILURE_MESSAGE
      || committed.run.state.checkpointVersion !== checkpoint.checkpointVersion
    ) {
      throw invariant(
        'Retired Tool Catalog terminalization returned a contradictory Run.'
      );
    }
    await this.observeDelegatedChildTerminal(committed.run, committed.events);
    return {
      receiptVersion: 1,
      commandId,
      runId: committed.run.runId,
      runVersion: committed.run.version,
      checkpointVersion: committed.run.state.checkpointVersion,
      status: 'failed',
      reason: 'tool_catalog_retired',
      errorCode: ERROR_CODE,
      replayed: committed.replayed
    };
  }

  private async observeDelegatedChildTerminal(
    run: AgentRun,
    events: readonly {
      readonly eventId: string;
      readonly occurredAt: string;
      readonly payload: { readonly type: string };
    }[]
  ): Promise<void> {
    if (run.binding.objectiveRef.kind !== 'parent_delegation') return;
    const terminalEvent = events.find((event) => event.payload.type === 'run.failed');
    if (terminalEvent === undefined) {
      throw invariant('Retired delegated Child has no durable terminal event.');
    }
    await this.childTerminals.observeTerminalChild({
      run,
      sourceRunEventId: terminalEvent.eventId,
      occurredAt: terminalEvent.occurredAt
    });
  }
}

function assertExactCatalog(run: AgentRun, observed: AgentRun): void {
  const actual = run.binding.toolCatalog;
  const expected = observed.binding.toolCatalog;
  if (
    actual.catalogId !== expected.catalogId
    || actual.revision !== expected.revision
    || actual.digest !== expected.digest
  ) {
    throw invariant(
      'Retired Tool Catalog identity drifted before terminalization.'
    );
  }
}

function terminalCheckpoint(run: AgentRun): AgentRunCheckpointCommit {
  const catalog = run.binding.toolCatalog;
  return {
    checkpointVersion: run.state.checkpointVersion + 1,
    createdAt: run.updatedAt,
    payload: {
      format: 'ariadne.agent-checkpoint',
      schemaVersion: 1,
      engineContinuation: {
        phase: 'execution_authority_terminalized',
        reason: 'tool_catalog_retired',
        toolCatalog: {
          catalogId: catalog.catalogId,
          revision: catalog.revision,
          digest: catalog.digest
        }
      },
      modelContext: null
    }
  };
}

function invariant(message: string): AgentRunInvariantError {
  return new AgentRunInvariantError(message);
}
