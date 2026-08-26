import type { RuntimeResponse } from '@ariadne/protocol/host';

export type RuntimeCommandOutcome = RuntimeResponse['outcome'];
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
  begin(commandId: string, commandDigest: string): RuntimeCommandBeginResult;
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
   */
  reconcileUncertain(
    commandId: string,
    commandDigest: string,
    reconciliation: RuntimeCommandReconciliation
  ): RuntimeCommandBeginResult;
  close(): void;
}
