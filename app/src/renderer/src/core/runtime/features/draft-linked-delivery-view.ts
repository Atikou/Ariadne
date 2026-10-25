import type { AgentInputDeliveryReceipt } from '../agent-input-delivery';

/** Immutable presentation follows actual receipt and draft-link changes. */
export class DraftLinkedDeliveryView {
  private source: AgentInputDeliveryReceipt[] | undefined;
  private value: AgentInputDeliveryReceipt[] | undefined;
  constructor(private readonly links: Map<string, string>) {}

  link(commandId: string, submissionId?: string): void {
    if (submissionId === undefined) this.links.delete(commandId);
    else this.links.set(commandId, submissionId);
    this.value = undefined;
  }

  read(rows: AgentInputDeliveryReceipt[]): AgentInputDeliveryReceipt[] {
    if (rows === this.source && this.value !== undefined) return this.value;
    const retained = new Set(rows.map(row => row.commandId));
    for (const id of this.links.keys()) if (!retained.has(id)) this.links.delete(id);
    this.source = rows;
    return this.value = Object.freeze(rows.map(row => {
      const draftSubmissionId = this.links.get(row.commandId);
      return draftSubmissionId ? Object.freeze({ ...row, draftSubmissionId }) : row;
    })) as AgentInputDeliveryReceipt[];
  }
}
