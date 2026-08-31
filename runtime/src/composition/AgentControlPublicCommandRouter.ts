import type { RuntimeApplicationCommandResult } from '../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../ingress/RuntimeIngress.js';
import type { RuntimeCommandReconciliation } from '../control/ports/RuntimeCommandJournal.js';
import type {
  AgentPublicCommandOwnerTable
} from './agent-entity/command-owners/AgentPublicCommandOwnerTable.js';

/** Thin public ingress adapter over an already compiled Agent Entity manifest. */
export class AgentControlPublicCommandRouter {
  public constructor(private readonly ownerTable: AgentPublicCommandOwnerTable) {}

  public executeOwnedCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeApplicationCommandResult | null> {
    return this.ownerTable.execute(envelope);
  }

  public reconcileUncertainCommand(
    envelope: RuntimeCommandEnvelope
  ): Promise<RuntimeCommandReconciliation | null> {
    return this.ownerTable.reconcile(envelope);
  }
}
