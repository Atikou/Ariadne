import type { RuntimeCommand } from '@ariadne/protocol/public';

import type { RuntimeApplicationCommandResult } from '../../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../../ingress/RuntimeIngress.js';
import type { RuntimeCommandReconciliation } from '../../../control/ports/RuntimeCommandJournal.js';

export type PublicCommandKind = RuntimeCommand['kind'];

export interface AgentPublicCommandOwner {
  readonly id: string;
  readonly commandKinds: readonly PublicCommandKind[];
  execute(envelope: RuntimeCommandEnvelope): Promise<RuntimeApplicationCommandResult>;
  reconcile(envelope: RuntimeCommandEnvelope): Promise<RuntimeCommandReconciliation>;
}

export interface AgentPublicCommandOwnerSnapshot {
  readonly id: string;
  readonly commandKinds: readonly PublicCommandKind[];
}

export interface AgentPublicCommandOwnerTable {
  execute(envelope: RuntimeCommandEnvelope): Promise<RuntimeApplicationCommandResult | null>;
  reconcile(envelope: RuntimeCommandEnvelope): Promise<RuntimeCommandReconciliation | null>;
  diagnosticSnapshot(): readonly AgentPublicCommandOwnerSnapshot[];
}

/** Compile one immutable, duplicate-free command ownership table before Runtime readiness. */
export function compileAgentPublicCommandOwnerTable(
  owners: readonly AgentPublicCommandOwner[]
): AgentPublicCommandOwnerTable {
  const ownersById = new Set<string>();
  const ownersByKind = new Map<PublicCommandKind, AgentPublicCommandOwner>();
  const snapshots: AgentPublicCommandOwnerSnapshot[] = [];
  for (const candidate of [...owners].sort((left, right) => compare(left.id, right.id))) {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(candidate.id)) {
      throw new Error(`agent_command_owner_id_invalid:${candidate.id}`);
    }
    if (ownersById.has(candidate.id)) {
      throw new Error(`agent_command_owner_id_duplicate:${candidate.id}`);
    }
    if (candidate.commandKinds.length === 0) {
      throw new Error(`agent_command_owner_empty:${candidate.id}`);
    }
    ownersById.add(candidate.id);
    const kinds = [...candidate.commandKinds].sort(compare);
    for (const kind of kinds) {
      const existing = ownersByKind.get(kind);
      if (existing !== undefined) {
        throw new Error(`agent_command_owner_duplicate:${kind}:${existing.id}:${candidate.id}`);
      }
      ownersByKind.set(kind, candidate);
    }
    snapshots.push(Object.freeze({
      id: candidate.id,
      commandKinds: Object.freeze(kinds)
    }));
  }
  const frozenSnapshots = Object.freeze(snapshots);
  return Object.freeze({
    execute: async (envelope: RuntimeCommandEnvelope) => (
      ownersByKind.get(envelope.command.kind)?.execute(envelope) ?? null
    ),
    reconcile: async (envelope: RuntimeCommandEnvelope) => (
      ownersByKind.get(envelope.command.kind)?.reconcile(envelope) ?? null
    ),
    diagnosticSnapshot: () => frozenSnapshots
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
