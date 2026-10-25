import type { RuntimeCommandJournalStatus } from './RuntimeCommandJournal.js';

export type RuntimeCommandBeginResultV2 =
  | { kind: 'started' } | { kind: 'replay'; outcome: unknown }
  | { kind: 'uncertain' } | { kind: 'conflict' };

export type RuntimeCommandReconciliationV2 =
  | { readonly kind: 'committed'; readonly outcome: unknown }
  | { readonly kind: 'not_committed' };

/**
 * V2 journals validated transport settlements without owning every business DTO.
 * The adapter validates input against the current response schema. Ingress
 * validates every replay before returning it to a transport. Physical schema,
 * command identity, recovery proofs and retention policy remain unchanged.
 */
export interface RuntimeCommandJournalV2 {
  readonly schemaVersion: number;
  open(dataRoot: string): void;
  begin(commandId: string, commandDigest: string, previousDigests?: readonly string[]): RuntimeCommandBeginResultV2;
  getStatus(commandId: string): RuntimeCommandJournalStatus | null;
  complete(commandId: string, commandDigest: string, outcome: unknown): void;
  markUncertain(commandId: string, commandDigest: string, outcome: unknown): void;
  reconcileUncertain(commandId: string, commandDigest: string, reconciliation: RuntimeCommandReconciliationV2): RuntimeCommandBeginResultV2;
  close(): void;
}
