import type { RuntimeEvent } from '@ariadne/protocol/public';

export interface ApprovalNotificationContent {
  title: string;
  body: string;
}

export interface ApprovalNotificationHandle {
  onClick(handler: () => void): void;
  show(): void;
  close(): void;
}

export interface ApprovalNotificationHost {
  isSupported(): boolean;
  isWindowFocused(): boolean;
  canNotify(): Promise<boolean>;
  create(content: ApprovalNotificationContent): ApprovalNotificationHandle;
  activateApplication(): void;
}

export class ApprovalNotificationService {
  private readonly notifiedIds = new Set<string>();
  private readonly pendingIds = new Set<string>();
  private readonly checkingIds = new Set<string>();
  private readonly visible = new Map<string, ApprovalNotificationHandle>();

  constructor(private readonly host: ApprovalNotificationHost) {}

  async handleRuntimeEvent(event: RuntimeEvent): Promise<void> {
    const approval = toApprovalEvent(event);
    if (!approval) return;
    if (!approval.pending) {
      this.pendingIds.delete(approval.id);
      this.notifiedIds.delete(approval.id);
      this.visible.get(approval.id)?.close();
      this.visible.delete(approval.id);
      return;
    }
    this.pendingIds.add(approval.id);
    if (
      this.host.isWindowFocused()
      || this.notifiedIds.has(approval.id)
      || this.checkingIds.has(approval.id)
      || !this.host.isSupported()
    ) return;

    this.checkingIds.add(approval.id);
    try {
      if (!await this.host.canNotify()) return;
      if (!this.pendingIds.has(approval.id) || this.host.isWindowFocused() || this.notifiedIds.has(approval.id)) return;
      const notification = this.host.create({
        title: 'Ariadne 需要你的确认',
        body: `${truncate(approval.title, 96)}\n打开 Ariadne 查看授权详情。`
      });
      notification.onClick(() => this.host.activateApplication());
      notification.show();
      this.notifiedIds.add(approval.id);
      this.visible.set(approval.id, notification);
    } catch (error) {
      console.error('Failed to show approval notification.', error);
    } finally {
      this.checkingIds.delete(approval.id);
    }
  }

  dispose(): void {
    for (const notification of this.visible.values()) notification.close();
    this.visible.clear();
    this.notifiedIds.clear();
    this.pendingIds.clear();
    this.checkingIds.clear();
  }
}

function toApprovalEvent(event: RuntimeEvent): { id: string; title: string; pending: boolean } | null {
  if (event.kind === 'agent.proposal.changed') {
    return {
      id: `proposal:${event.proposal.proposalId}`,
      title: event.proposal.title,
      pending: event.proposal.status === 'pending'
    };
  }
  if (event.kind === 'permission.changed') {
    return {
      id: `permission:${event.request.requestId}`,
      title: event.request.title,
      pending: event.request.status === 'pending'
    };
  }
  return null;
}

function truncate(value: string, maximumLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maximumLength ? `${normalized.slice(0, maximumLength - 1)}…` : normalized;
}
