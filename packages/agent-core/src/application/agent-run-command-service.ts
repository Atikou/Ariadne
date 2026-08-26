import {
  AgentRunAlreadyExistsError,
  AgentRunCommandConflictError,
  AgentRunInvariantError,
  AgentRunNotFoundError,
  AgentRunVersionConflictError
} from '../domain/errors.js';
import {
  assertCanonicalPublicId,
  assertPositiveInteger,
  assertTimestamp
} from '../domain/values.js';
import {
  createAgentRun,
  transitionAgentRun
} from './transition-agent-run.js';
import type {
  AgentRunCommand
} from './commands.js';
import type {
  AgentRunEvent,
  AgentRunEventPayload
} from './events.js';
import type {
  AgentEffectResultContinuationAuthorityCheck,
  AgentRunCommandCommit,
  AgentRunUnitOfWork,
  CommittedAgentRunMutation,
  CommittedAgentRunCommand
} from './unit-of-work.js';
import type { AgentRun } from '../domain/agent-run.js';
import {
  sha256AgentRunCommandDigester,
  type AgentRunCommandDigester
} from './command-digest.js';
import {
  assertAgentRunCommitArtifacts,
  assertAgentRunCommitArtifactDigests,
  type AgentRunCommitArtifacts
} from './recovery-persistence.js';
import {
  sha256AgentCommittedDirectiveDigester,
  type AgentCommittedDirectiveDigester
} from './directive-digest.js';
import { admitAgentRun } from './admit-agent-run.js';
import {
  EMPTY_AGENT_CONTROL_COMMIT_FACTS,
  assertAgentControlCommitFacts,
  type AgentControlCommitFacts
} from '../domain/plan-budget-delegation.js';

export interface AgentRunCommandResult {
  readonly commandId: string;
  readonly run: AgentRun;
  readonly events: readonly AgentRunEvent[];
  readonly replayed: boolean;
}

/**
 * The only application write entry point for AgentRun state.
 */
export class AgentRunCommandService {
  public constructor(
    private readonly unitOfWork: AgentRunUnitOfWork,
    private readonly commandDigester: AgentRunCommandDigester = sha256AgentRunCommandDigester,
    private readonly directiveDigester: AgentCommittedDirectiveDigester =
      sha256AgentCommittedDirectiveDigester
  ) {}

  public async execute(
    command: AgentRunCommand,
    artifacts: AgentRunCommitArtifacts,
    facts: AgentControlCommitFacts = EMPTY_AGENT_CONTROL_COMMIT_FACTS
  ): Promise<AgentRunCommandResult> {
    assertCanonicalPublicId(command.commandId, 'command.commandId');
    assertCanonicalPublicId(command.runId, 'command.runId');
    assertTimestamp(command.occurredAt, 'command.occurredAt');
    if (command.kind !== 'run.start' && command.kind !== 'run.admit') {
      assertPositiveInteger(command.expectedVersion, 'command.expectedVersion');
    }
    if (
      command.kind === 'run.record_inference_attempt_result'
      && command.result.status === 'succeeded'
    ) {
      const actualDirectiveDigest = await this.directiveDigester.digest(
        command.result.directive
      );
      if (actualDirectiveDigest !== command.result.directiveDigest) {
        throw new AgentRunInvariantError(
          'The inference directive digest does not match its canonical directive.'
        );
      }
    }
    const commandDigest = await this.commandDigester.digest(command);
    const controlFacts = controlFactsForCommand(command, facts);

    return this.unitOfWork.transaction(async (transaction) => {
      const committed = await transaction.loadCommittedCommand(
        command.commandId,
        [{ runId: command.runId, artifacts }],
        controlFacts
      );
      if (committed !== null) {
        const mutation = requireSingleMutation(committed, command.runId);
        if (mutation.runId !== command.runId) {
          throw new AgentRunCommandConflictError(
            command.commandId,
            mutation.runId,
            command.runId
          );
        }
        if (committed.commandDigest !== commandDigest) {
          throw new AgentRunCommandConflictError(
            command.commandId,
            mutation.runId,
            command.runId,
            'command_mismatch'
          );
        }
        return replayResult(committed.commandId, mutation);
      }

      const current = await transaction.loadRun(command.runId);
      let transition;
      let expectedVersion: number | null;

      if (command.kind === 'run.start' || command.kind === 'run.admit') {
        if (current !== null) {
          throw new AgentRunAlreadyExistsError(command.runId);
        }
        transition = command.kind === 'run.admit'
          ? admitAgentRun(command)
          : createAgentRun(command);
        expectedVersion = null;
      } else {
        if (current === null) {
          throw new AgentRunNotFoundError(command.runId);
        }
        if (current.version !== command.expectedVersion) {
          throw new AgentRunVersionConflictError(
            command.runId,
            command.expectedVersion,
            current.version
          );
        }
        transition = transitionAgentRun(current, command);
        expectedVersion = current.version;
      }

      const events = decorateEvents(
        command,
        commandDigest,
        transition.run.version,
        transition.events
      );
      assertAgentRunCommitArtifacts(current, transition.run, artifacts);
      await assertAgentRunCommitArtifactDigests(current, transition.run, artifacts);
      if (
        command.kind === 'run.register_turn'
        && command.turn.cause.kind === 'effect_results'
      ) {
        const assertAuthority = transaction.assertEffectResultContinuationAuthority;
        if (assertAuthority === undefined) {
          throw new AgentRunInvariantError(
            'The persistence transaction cannot prove effect-result continuation authority.'
          );
        }
        const turnInput = artifacts.turnInputPayloads.find(
          (candidate) => candidate.turnId === command.turn.turnId
        );
        if (turnInput === undefined) {
          throw new AgentRunInvariantError(
            'An effect-result continuation requires its exact protected Turn input snapshot.'
          );
        }
        const authorityCheck: AgentEffectResultContinuationAuthorityCheck = {
          commandId: command.commandId,
          runId: command.runId,
          expectedVersion: command.expectedVersion,
          resultingVersion: transition.run.version,
          turnId: command.turn.turnId,
          inputDigest: command.turn.inputDigest,
          snapshot: turnInput.payload
        };
        await assertAuthority.call(transaction, authorityCheck);
      }
      const commit: AgentRunCommandCommit = {
        commandId: command.commandId,
        commandDigest,
        mutations: [{
          runId: command.runId,
          expectedVersion,
          resultingVersion: transition.run.version,
          run: transition.run,
          events,
          artifacts
        }],
        facts: controlFacts
      };
      await transaction.commitCommand(commit);

      return {
        commandId: command.commandId,
        run: transition.run,
        events,
        replayed: false
      };
    });
  }
}

function controlFactsForCommand(
  command: AgentRunCommand,
  supplied: AgentControlCommitFacts
): AgentControlCommitFacts {
  assertAgentControlCommitFacts(supplied);
  if (command.kind === 'run.start' || command.kind === 'run.admit') {
    if (!emptyControlFacts(supplied)) {
      throw new AgentRunInvariantError(
        'Run creation facts are derived exclusively from the immutable binding.'
      );
    }
    return createRunCreationFacts(command);
  }
  if (emptyControlFacts(supplied)) return supplied;
  if (
    command.kind !== 'run.record_inference_attempt_result'
    || command.result.status !== 'succeeded'
    || command.result.directive.kind !== 'request_decision'
    || supplied.planVersions.length !== 1
    || supplied.planApprovals.length !== 0
    || supplied.budgetGrants.length !== 0
    || supplied.budgetEntries.length !== 0
    || supplied.delegations.length !== 0
    || supplied.childTerminals.length !== 0
  ) {
    throw new AgentRunInvariantError(
      'Inference result facts may contain only the exact requested Plan version.'
    );
  }
  const decision = command.result.directive.decision;
  const plan = supplied.planVersions[0]!;
  if (
    plan.runId !== command.runId
    || plan.createdAt !== command.occurredAt
    || plan.ref.planId !== decision.planId
    || plan.ref.version !== decision.planVersion
    || plan.ref.contentHash !== decision.planHash
  ) {
    throw new AgentRunInvariantError(
      'The immutable Plan fact must match the committed decision exactly.'
    );
  }
  return supplied;
}

function emptyControlFacts(facts: AgentControlCommitFacts): boolean {
  return facts.planVersions.length === 0
    && facts.planApprovals.length === 0
    && facts.budgetGrants.length === 0
    && facts.budgetEntries.length === 0
    && facts.delegations.length === 0
    && facts.childTerminals.length === 0;
}

function createRunCreationFacts(command: AgentRunCommand): AgentControlCommitFacts {
  if (command.kind !== 'run.start' && command.kind !== 'run.admit') {
    return EMPTY_AGENT_CONTROL_COMMIT_FACTS;
  }
  const grant = command.binding.budget;
  if (grant.source.kind !== 'root') {
    throw new AgentRunInvariantError(
      'Delegated Runs must be created by the atomic parent delegation command.'
    );
  }
  return {
    ...EMPTY_AGENT_CONTROL_COMMIT_FACTS,
    budgetGrants: [{
      grantId: grant.grantId,
      runId: command.runId,
      vector: { ...grant.vector },
      deadlineAt: grant.deadlineAt,
      createdAt: command.occurredAt,
      source: { kind: 'root' }
    }],
    budgetEntries: [{
      kind: 'root_grant',
      entryId: `budget-entry:root:${grant.grantId}`,
      runId: command.runId,
      grantId: grant.grantId,
      vector: { ...grant.vector },
      occurredAt: command.occurredAt
    }]
  };
}

function decorateEvents(
  command: AgentRunCommand,
  commandDigest: string,
  runVersion: number,
  payloads: readonly AgentRunEventPayload[]
): AgentRunEvent[] {
  return payloads.map((payload, index) => {
    const sequence = index + 1;
    return {
      eventId: `event:${commandDigest.slice('sha256:'.length)}:${String(sequence)}`,
      commandId: command.commandId,
      runId: command.runId,
      runVersion,
      sequence,
      occurredAt: command.occurredAt,
      payload
    };
  });
}

function replayResult(
  commandId: string,
  mutation: CommittedAgentRunMutation
): AgentRunCommandResult {
  return {
    commandId,
    run: mutation.run,
    events: mutation.events,
    replayed: true
  };
}

function requireSingleMutation(
  committed: CommittedAgentRunCommand,
  expectedRunId: string
): CommittedAgentRunMutation {
  const mutation = committed.mutations[0];
  if (committed.mutations.length !== 1 || mutation === undefined) {
    const actual = committed.mutations.map((item) => item.runId).join(',');
    throw new AgentRunCommandConflictError(
      committed.commandId,
      actual,
      expectedRunId,
      'command_mismatch'
    );
  }
  return mutation;
}
