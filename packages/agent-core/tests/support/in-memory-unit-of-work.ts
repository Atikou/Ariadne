import {
  AgentRunCommandConflictError,
  AgentRunCommandService,
  AgentRunVersionConflictError,
  type AgentRunCommand,
  type AgentRunCommandResult,
  type AgentRun,
  type AgentRunCommandCommit,
  type AgentRunCommitMutation,
  type AgentRunCommitArtifacts,
  type AgentRunEvent,
  type AgentRunTransaction,
  type AgentRunUnitOfWork,
  type CommittedAgentRunCommand,
  type AgentControlCommitFacts,
  type AgentPlanVersionCommit,
  type AgentBudgetGrantCommit,
  type AgentBudgetLedgerEntryCommit,
  type AgentChildTerminalCommit,
  type AgentDelegationCommit,
  type AgentBudgetSnapshot,
  EMPTY_AGENT_CONTROL_COMMIT_FACTS,
  zeroAgentBudgetVector,
  addAgentBudgetVectors,
  subtractAgentBudgetVectors,
  digestAgentTurnInput,
  type AgentTurnInputModelData
} from '../../src/index.js';

export class InMemoryAgentRunUnitOfWork implements AgentRunUnitOfWork {
  private readonly runs = new Map<string, AgentRun>();
  private readonly commands = new Map<string, CommittedAgentRunCommand>();
  private readonly commandArtifacts = new Map<string, ReadonlyMap<string, AgentRunCommitArtifacts>>();
  private readonly commandFacts = new Map<string, AgentControlCommitFacts>();
  private readonly plans = new Map<string, AgentPlanVersionCommit>();
  private readonly grants = new Map<string, AgentBudgetGrantCommit>();
  private readonly budgetEntries: AgentBudgetLedgerEntryCommit[] = [];
  private readonly delegations = new Map<string, AgentDelegationCommit>();
  private readonly terminals = new Map<string, AgentChildTerminalCommit>();
  private readonly eventLog: AgentRunEvent[] = [];
  private transactionTail: Promise<void> = Promise.resolve();
  private forcedConflictActualVersion: number | null | undefined;

  public lastAttemptedCommit: AgentRunCommitMutation | null = null;
  public transactionCount = 0;
  public commitCount = 0;

  public async transaction<T>(
    operation: (transaction: AgentRunTransaction) => Promise<T>
  ): Promise<T> {
    this.transactionCount += 1;
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation({
      loadRun: async (runId) => cloneJson(this.runs.get(runId) ?? null),
      loadCommittedCommand: async (commandId, artifacts = [], facts) => {
        const committed = this.commands.get(commandId) ?? null;
        if (
          committed !== null
          && canonicalJson([...this.commandArtifacts.get(commandId)?.entries() ?? []])
            !== canonicalJson(artifacts.map((item) => [item.runId, item.artifacts]))
        ) {
          const actualRunIds = committed.mutations.map((item) => item.runId).join(',');
          throw new AgentRunCommandConflictError(
            commandId,
            actualRunIds,
            artifacts.map((item) => item.runId).join(','),
            'command_mismatch'
          );
        }
        if (
          committed !== null
          && facts !== undefined
          && canonicalJson(this.commandFacts.get(commandId) ?? EMPTY_AGENT_CONTROL_COMMIT_FACTS)
            !== canonicalJson(facts)
        ) {
          throw new AgentRunCommandConflictError(
            commandId,
            'control-facts',
            'control-facts',
            'command_mismatch'
          );
        }
        return cloneJson(committed);
      },
      loadPlanVersion: async (reference) =>
        this.plans.get(`${reference.planId}\u0000${String(reference.version)}`) ?? null,
      loadBudgetSnapshot: async (grantId) => this.budgetSnapshot(grantId),
      loadDelegationByChild: async (childRunId) => {
        const delegation = [...this.delegations.values()].find(
          (item) => item.childRunId === childRunId
        );
        return delegation === undefined ? null : {
          ...cloneJson(delegation),
          terminal: cloneJson(this.terminals.get(delegation.delegationId) ?? null)
        };
      },
      listDelegationsByParent: async (parentRunId) =>
        [...this.delegations.values()]
          .filter((item) => item.parentRunId === parentRunId)
          .sort((left, right) => left.childRunId < right.childRunId ? -1 : 1)
          .map((item) => ({
            ...cloneJson(item),
            terminal: cloneJson(this.terminals.get(item.delegationId) ?? null)
          })),
      loadChildTerminal: async (delegationId) =>
        cloneJson(this.terminals.get(delegationId) ?? null),
      assertEffectResultContinuationAuthority: async () => {
        // Test-only store has no separate protected Effect-result table. Runtime
        // persistence adapters must replace this with durable evidence checks.
      },
      commitCommand: async (commit: AgentRunCommandCommit) => {
        this.commitCount += 1;
        this.lastAttemptedCommit = cloneJson(commit.mutations[0] ?? null);
        if (commit.mutations.length === 0) {
          throw new Error('A command must contain at least one Run mutation.');
        }
        const sortedRunIds = [...commit.mutations].map((item) => item.runId);
        if (sortedRunIds.some((runId, index) => index > 0 && sortedRunIds[index - 1]! >= runId)) {
          throw new Error('Run mutations must be unique and strictly sorted.');
        }
        if (this.forcedConflictActualVersion !== undefined) {
          const actual = this.forcedConflictActualVersion;
          this.forcedConflictActualVersion = undefined;
          const first = commit.mutations[0]!;
          throw new AgentRunVersionConflictError(
            first.runId,
            first.expectedVersion,
            actual
          );
        }

        for (const mutation of commit.mutations) {
          const current = this.runs.get(mutation.runId) ?? null;
          const actualVersion = current?.version ?? null;
          if (actualVersion !== mutation.expectedVersion) {
            throw new AgentRunVersionConflictError(
              mutation.runId,
              mutation.expectedVersion,
              actualVersion
            );
          }

          const expectedNextVersion = (actualVersion ?? 0) + 1;
          if (
            mutation.run.version !== expectedNextVersion
            || mutation.resultingVersion !== expectedNextVersion
          ) {
            throw new Error('The committed run version must advance exactly once.');
          }
        }

        const facts = commit.facts ?? EMPTY_AGENT_CONTROL_COMMIT_FACTS;
        for (const plan of facts.planVersions) {
          if (this.plans.has(`${plan.ref.planId}\u0000${String(plan.ref.version)}`)) {
            throw new Error('immutable plan version already exists');
          }
        }
        for (const grant of facts.budgetGrants) {
          if (this.grants.has(grant.grantId)) throw new Error('immutable grant exists');
        }
        for (const delegation of facts.delegations) {
          if (this.delegations.has(delegation.delegationId)) {
            throw new Error('immutable delegation exists');
          }
        }
        for (const terminal of facts.childTerminals) {
          if (this.terminals.has(terminal.delegationId)) {
            throw new Error('immutable child terminal exists');
          }
        }

        for (const mutation of commit.mutations) {
          this.runs.set(mutation.runId, cloneJson(mutation.run));
        }
        this.commands.set(commit.commandId, cloneJson({
          commandId: commit.commandId,
          commandDigest: commit.commandDigest,
          mutations: commit.mutations.map(({ expectedVersion: _expectedVersion, artifacts: _artifacts, ...item }) => item)
        }));
        this.commandArtifacts.set(
          commit.commandId,
          new Map(commit.mutations.map((item) => [
            item.runId,
            cloneJson(item.artifacts ?? { turnInputPayloads: [], effectPayloads: [] })
          ]))
        );
        this.commandFacts.set(commit.commandId, cloneJson(facts));
        for (const plan of facts.planVersions) {
          this.plans.set(
            `${plan.ref.planId}\u0000${String(plan.ref.version)}`,
            cloneJson(plan)
          );
        }
        for (const grant of facts.budgetGrants) {
          this.grants.set(grant.grantId, cloneJson(grant));
        }
        this.budgetEntries.push(...cloneJson(facts.budgetEntries));
        for (const delegation of facts.delegations) {
          this.delegations.set(delegation.delegationId, cloneJson(delegation));
        }
        for (const terminal of facts.childTerminals) {
          this.terminals.set(terminal.delegationId, cloneJson(terminal));
        }
        for (const mutation of commit.mutations) {
          this.eventLog.push(...cloneJson(mutation.events));
        }
      }
      });
    } finally {
      release();
    }
  }

  public loadRun(runId: string): AgentRun | null {
    return cloneJson(this.runs.get(runId) ?? null);
  }

  public events(): readonly AgentRunEvent[] {
    return cloneJson(this.eventLog);
  }

  public loadCommittedArtifacts(commandId: string): AgentRunCommitArtifacts | null {
    const artifacts = this.commandArtifacts.get(commandId);
    if (artifacts === undefined || artifacts.size !== 1) return null;
    const value = artifacts.values().next().value as AgentRunCommitArtifacts | undefined;
    return value === undefined ? null : cloneJson(value);
  }

  public loadCommittedReceipt(commandId: string): CommittedAgentRunCommand | null {
    const command = this.commands.get(commandId);
    return command === undefined ? null : cloneJson(command);
  }

  public forceNextVersionConflict(actualVersion: number | null): void {
    this.forcedConflictActualVersion = actualVersion;
  }

  /** Simulates closing and reopening an opaque JSON aggregate store. */
  public reopen(): InMemoryAgentRunUnitOfWork {
    const reopened = new InMemoryAgentRunUnitOfWork();
    for (const [runId, run] of this.runs) {
      reopened.runs.set(runId, cloneJson(run));
    }
    for (const [commandId, command] of this.commands) {
      reopened.commands.set(commandId, cloneJson(command));
    }
    for (const [commandId, artifacts] of this.commandArtifacts) {
      reopened.commandArtifacts.set(commandId, new Map(
        [...artifacts].map(([runId, value]) => [runId, cloneJson(value)])
      ));
    }
    for (const [commandId, facts] of this.commandFacts) {
      reopened.commandFacts.set(commandId, cloneJson(facts));
    }
    for (const [key, plan] of this.plans) reopened.plans.set(key, cloneJson(plan));
    for (const [key, grant] of this.grants) reopened.grants.set(key, cloneJson(grant));
    reopened.budgetEntries.push(...cloneJson(this.budgetEntries));
    for (const [key, delegation] of this.delegations) {
      reopened.delegations.set(key, cloneJson(delegation));
    }
    for (const [key, terminal] of this.terminals) {
      reopened.terminals.set(key, cloneJson(terminal));
    }
    reopened.eventLog.push(...cloneJson(this.eventLog));
    return reopened;
  }

  private budgetSnapshot(grantId: string): AgentBudgetSnapshot | null {
    const grant = this.grants.get(grantId);
    if (grant === undefined) return null;
    let spent = zeroAgentBudgetVector();
    let allocated = zeroAgentBudgetVector();
    const open = new Map<string, AgentBudgetGrantCommit['vector']>();
    for (const entry of this.budgetEntries.filter((item) => item.grantId === grantId)) {
      switch (entry.kind) {
        case 'root_grant':
          break;
        case 'parent_allocation':
          allocated = addAgentBudgetVectors(allocated, entry.vector);
          break;
        case 'reservation':
          open.set(entry.reservationId, entry.vector);
          break;
        case 'settlement':
          open.delete(entry.reservationId);
          spent = addAgentBudgetVectors(spent, entry.vector);
          break;
        case 'release':
          open.delete(entry.reservationId);
          break;
        case 'child_release':
          allocated = subtractAgentBudgetVectors(allocated, entry.vector);
          break;
      }
    }
    let reserved = zeroAgentBudgetVector();
    for (const vector of open.values()) reserved = addAgentBudgetVectors(reserved, vector);
    const available = subtractAgentBudgetVectors(
      subtractAgentBudgetVectors(
        subtractAgentBudgetVectors(grant.vector, spent),
        reserved
      ),
      allocated
    );
    return {
      grant: cloneJson(grant),
      available,
      reserved,
      spent,
      allocated,
      openReservations: [...open.entries()]
        .sort(([left], [right]) => left < right ? -1 : 1)
        .map(([reservationId, vector]) => ({ reservationId, vector }))
    };
  }
}

/** Supplies deterministic non-sensitive recovery material to domain tests. */
export class TestAgentRunCommandService extends AgentRunCommandService {
  public constructor(
    private readonly memory: InMemoryAgentRunUnitOfWork,
    private readonly turnInputs: readonly AgentTurnInputModelData[] = []
  ) {
    super(memory);
  }

  public override async execute(command: AgentRunCommand): Promise<AgentRunCommandResult> {
    return super.execute(
      command,
      await testRecoveryArtifacts(command, this.memory, this.turnInputs)
    );
  }
}

async function testRecoveryArtifacts(
  command: AgentRunCommand,
  memory: InMemoryAgentRunUnitOfWork,
  turnInputs: readonly AgentTurnInputModelData[]
): Promise<AgentRunCommitArtifacts> {
  const effectPayloads: AgentRunCommitArtifacts['effectPayloads'] =
    command.kind === 'run.register_effect'
      ? [{
          kind: 'record_input',
          effectId: command.effect.effectId,
          inputDigest: command.effect.inputDigest,
          input: { fixtureDigest: command.effect.inputDigest },
          recordedAt: command.occurredAt
        }]
      : command.kind === 'run.record_effect_result'
          && command.result.status !== 'uncertain'
        ? [{
            kind: 'record_result',
            effectId: command.effectId,
            inputDigest: `sha256:${'b'.repeat(64)}`,
            result: { ...command.result },
            recordedAt: command.occurredAt
          }]
        : [];
  const terminal = command.kind === 'run.complete'
    || command.kind === 'run.fail'
    || command.kind === 'run.cancel';
  const turnInputPayloads: AgentRunCommitArtifacts['turnInputPayloads'] =
    command.kind === 'run.register_turn'
      ? [await testTurnInputPayload(command, memory, turnInputs)]
      : [];
  return {
    turnInputPayloads,
    effectPayloads,
    directivePayloads: directivePayloadsForCommand(command),
    ...(command.kind !== 'run.start' && !terminal
      ? {
          checkpoint: {
            checkpointVersion: command.kind === 'run.admit'
              ? 1
              : command.expectedVersion,
            payload: {
              format: 'ariadne.agent-checkpoint' as const,
              schemaVersion: 1 as const,
              engineContinuation: { commandId: command.commandId },
              modelContext: []
            },
            createdAt: command.occurredAt
          }
        }
      : {})
  };
}

async function testTurnInputPayload(
  command: Extract<AgentRunCommand, { readonly kind: 'run.register_turn' }>,
  memory: InMemoryAgentRunUnitOfWork,
  turnInputs: readonly AgentTurnInputModelData[]
): Promise<AgentRunCommitArtifacts['turnInputPayloads'][number]> {
  let input: AgentTurnInputModelData | undefined;
  for (const candidate of turnInputs) {
    if (await digestAgentTurnInput(candidate) === command.turn.inputDigest) {
      input = candidate;
      break;
    }
  }
  input ??= turnInputs[0];
  if (input === undefined) {
    throw new Error('A test register_turn command requires its exact Turn input fixture.');
  }
  const run = memory.loadRun(command.runId);
  if (run === null) throw new Error('A test register_turn command requires its Run.');
  const objective = run.binding.objectiveRef;
  return {
    turnId: command.turn.turnId,
    inputDigest: command.turn.inputDigest,
    recordedAt: command.occurredAt,
    payload: {
      format: 'ariadne.agent-turn-input',
      schemaVersion: 1,
      runId: command.runId,
      turnId: command.turn.turnId,
      cause: cloneJson(command.turn.cause),
      authorityRef: objective.kind === 'conversation_message'
        ? {
            kind: 'conversation_message',
            sessionId: run.binding.sessionId,
            workspaceId: run.binding.workspace.workspaceId,
            messageId: objective.messageId,
            messageVersion: objective.messageVersion,
            contentDigest: objective.contentDigest
          }
        : {
            kind: 'parent_delegation',
            parentRunId: objective.parentRunId,
            delegationId: objective.delegationId,
            objectiveDigest: objective.objectiveDigest,
            mode: objective.mode,
            providerId: objective.providerId
          },
      messages: cloneJson(input.messages),
      availableTools: cloneJson(input.availableTools)
    }
  };
}

function directivePayloadsForCommand(
  command: AgentRunCommand
): NonNullable<AgentRunCommitArtifacts['directivePayloads']> {
  if (
    command.kind !== 'run.record_inference_attempt_result'
    || command.result.status !== 'succeeded'
  ) return [];
  const directive = command.result.directive;
  const base = {
    directiveDigest: command.result.directiveDigest,
    recordedAt: command.occurredAt
  };
  switch (directive.kind) {
    case 'respond':
      return [{
        ...base,
        artifactId: directive.contentRef,
        kind: 'response_content',
        contentDigest: directive.contentDigest,
        payload: `fixture:${directive.contentRef}`
      }];
    case 'ask_user':
      return [{
        ...base,
        artifactId: directive.questionRef,
        kind: 'user_question',
        contentDigest: directive.questionDigest,
        payload: {
          format: 'ariadne.user-question',
          schemaVersion: 1,
          prompt: `fixture:${directive.questionRef}`
        }
      }];
    case 'checkpoint':
      return [{
        ...base,
        artifactId: directive.reasonRef,
        kind: 'checkpoint_reason',
        contentDigest: directive.reasonDigest,
        payload: `fixture:${directive.reasonRef}`
      }];
    case 'complete':
      return directive.outputRef === undefined || directive.outputDigest === undefined
        ? []
        : [{
            ...base,
            artifactId: directive.outputRef,
            kind: 'completion_output',
            contentDigest: directive.outputDigest,
            payload: `fixture:${directive.outputRef}`
          }];
    case 'fail':
      return [{
        ...base,
        artifactId: directive.messageRef,
        kind: 'failure_message',
        contentDigest: directive.messageDigest,
        payload: `fixture:${directive.messageRef}`
      }];
    case 'invoke_tools':
    case 'request_decision':
      return [];
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
