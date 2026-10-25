import type { RuntimeResponse } from '@ariadne/protocol/host';
import type { RuntimeResult } from '@ariadne/protocol/public';

/** Released V1 result discriminants; new read models must not mutate this ABI. */
type RuntimeCommandResultKindV1 =
  | 'model.quality.completed' | 'goal.updated' | 'todo.snapshot.replaced' | 'productivity.query_result'
  | 'workflow.updated' | 'schedule.updated' | 'schedules.query_result' | 'schedule.occurrences.query_result'
  | 'schedule.occurrence.updated' | 'memory.query_result' | 'memory.read_result' | 'memory.updated'
  | 'memory.deleted' | 'memory.recall_result' | 'workspace.document.read_result' | 'workspace.document.saved'
  | 'workspace.document.moved' | 'workspace.document.deleted' | 'runtime.status' | 'model.qualification.completed'
  | 'model.availability.completed' | 'projection.snapshot' | 'projection.commits' | 'conversation.session.created'
  | 'conversation.session.updated' | 'conversation.session.title.generated' | 'conversation.session.forked'
  | 'conversation.sessions.query_result' | 'conversation.message.resolved' | 'skill.commands.query_result'
  | 'skill.command.loaded' | 'skill.command.resource' | 'agent.tool_result.detail' | 'conversation.message.accepted'
  | 'agent.decision.resolved' | 'agent.run.cancelled' | 'agent.run.cancellation.requested' | 'agent.inbox.enqueued'
  | 'agent.inbox.replaced' | 'agent.inbox.removed' | 'agent.subagent.input.sent' | 'agent.subagent.interrupted' | 'acknowledged';

export type RuntimeCommandOutcome = Extract<RuntimeResponse['outcome'], { ok: false }>
  | { ok: true; result: Extract<RuntimeResult, { kind: RuntimeCommandResultKindV1 }> };
export type RuntimeCommandJournalStatus = 'executing' | 'completed' | 'uncertain';

export type RuntimeCommandBeginResult =
  | { kind: 'started' }
  | { kind: 'replay'; outcome: RuntimeCommandOutcome }
  | { kind: 'uncertain' }
  | { kind: 'conflict' };

export type RuntimeCommandReconciliation =
  | {
      /** A domain-owned durable receipt proves the command committed. */
      readonly kind: 'committed';
      readonly outcome: RuntimeCommandOutcome;
    }
  | {
      /** Every domain owner proves that no in-scope write committed. */
      readonly kind: 'not_committed';
    };

/**
 * Durable authority for logical Runtime commands.
 *
 * Transport attempts are intentionally absent from this contract. The stable
 * commandId and digest own replay semantics across Runtime process restarts.
 */
export interface RuntimeCommandJournal {
  readonly schemaVersion: number;
  open(dataRoot: string): void;
  /** Previous digests are proofs derived by trusted ingress from this exact input, never caller-supplied wire fields. */
  begin(commandId: string, commandDigest: string, previousDigests?: readonly string[]): RuntimeCommandBeginResult;
  getStatus(commandId: string): RuntimeCommandJournalStatus | null;
  /**
   * Records a deterministic settlement. A persistence policy may retain only
   * an uncertain identity tombstone when the full outcome is not replay-safe.
   */
  complete(
    commandId: string,
    commandDigest: string,
    outcome: RuntimeCommandOutcome
  ): void;
  /**
   * Records a permanent non-replayable identity tombstone. The supplied
   * outcome is validation context and must not become a replay payload.
   */
  markUncertain(
    commandId: string,
    commandDigest: string,
    outcome: RuntimeCommandOutcome
  ): void;
  /**
   * Resolves an uncertain ingress tombstone only after an owning domain has
   * supplied positive durable evidence. This is not a generic retry API:
   * callers must reconcile every store that the routed command can mutate.
   * A reconstructed receipt may be delivered without being retained; in that
   * case the tombstone stays uncertain and future attempts reconcile again.
   */
  reconcileUncertain(
    commandId: string,
    commandDigest: string,
    reconciliation: RuntimeCommandReconciliation
  ): RuntimeCommandBeginResult;
  close(): void;
}
