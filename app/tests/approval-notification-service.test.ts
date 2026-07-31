import { describe, expect, it, vi } from 'vitest';
import type { AgentProposal, PermissionRequest, RuntimeEvent } from '@ariadne/protocol/public';
import {
  ApprovalNotificationService,
  type ApprovalNotificationHandle,
  type ApprovalNotificationHost
} from '../src/main/services/approval-notification-service';

describe('ApprovalNotificationService', () => {
  it('does not create a system notification while the application is focused', async () => {
    const fixture = createFixture(true);
    await fixture.service.handleRuntimeEvent(proposalEvent('pending'));
    expect(fixture.host.create).not.toHaveBeenCalled();
  });

  it('notifies once while unfocused and restores the application when clicked', async () => {
    const fixture = createFixture(false);
    const event = proposalEvent('pending');
    await fixture.service.handleRuntimeEvent(event);
    await fixture.service.handleRuntimeEvent(event);

    expect(fixture.host.create).toHaveBeenCalledOnce();
    expect(fixture.host.create).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Ariadne 需要你的确认',
      body: expect.stringContaining('创建项目')
    }));
    fixture.click?.();
    expect(fixture.host.activateApplication).toHaveBeenCalledOnce();
    expect(fixture.host.activateApplication).toHaveBeenCalledWith('session-1');
  });

  it('closes a proposal notification after a decision and can notify a later pending request', async () => {
    const fixture = createFixture(false);
    await fixture.service.handleRuntimeEvent(proposalEvent('pending'));
    await fixture.service.handleRuntimeEvent(proposalEvent('approved'));
    expect(fixture.notification.close).toHaveBeenCalledOnce();

    await fixture.service.handleRuntimeEvent(permissionEvent('pending'));
    expect(fixture.host.create).toHaveBeenCalledTimes(2);
  });

  it('keeps the approval pending without notifying when interruption policy suppresses it', async () => {
    const fixture = createFixture(false, false);
    await fixture.service.handleRuntimeEvent(permissionEvent('pending'));
    expect(fixture.host.create).not.toHaveBeenCalled();
  });

  it('exposes a manual Windows notification preview without requiring a pending run', () => {
    const fixture = createFixture(true);
    expect(fixture.service.showTestNotification()).toEqual({ shown: true, supported: true });
    expect(fixture.host.create).toHaveBeenCalledOnce();
    expect(fixture.notification.show).toHaveBeenCalledOnce();
    fixture.click?.();
    expect(fixture.host.activateApplication).toHaveBeenCalledWith();
  });
});

function createFixture(focused: boolean, canNotify = true): {
  service: ApprovalNotificationService;
  host: ApprovalNotificationHost & { create: ReturnType<typeof vi.fn>; activateApplication: ReturnType<typeof vi.fn> };
  notification: ApprovalNotificationHandle & { close: ReturnType<typeof vi.fn> };
  click: (() => void) | null;
} {
  let click: (() => void) | null = null;
  const notification = {
    onClick: vi.fn((handler: () => void) => { click = handler; }),
    show: vi.fn(),
    close: vi.fn()
  };
  const host = {
    isSupported: () => true,
    isWindowFocused: () => focused,
    canNotify: async () => canNotify,
    create: vi.fn(() => notification),
    activateApplication: vi.fn()
  };
  return {
    service: new ApprovalNotificationService(host),
    host,
    notification,
    get click() { return click; }
  };
}

function proposalEvent(status: AgentProposal['status']): RuntimeEvent {
  return {
    kind: 'agent.proposal.changed',
    proposal: {
      proposalId: 'proposal-1',
      sessionId: 'session-1',
      title: '创建项目',
      reason: '需要写入文件。',
      originalRequest: '创建一个项目',
      workspaceIds: ['primary'],
      requestedScopes: ['E:\\Temp'],
      requestedCapabilities: ['file-write'],
      risk: 'write',
      status,
      createdAt: '2026-07-22T00:00:00.000Z'
    }
  };
}

function permissionEvent(status: PermissionRequest['status']): RuntimeEvent {
  return {
    kind: 'permission.changed',
    request: {
      requestId: 'permission-1',
      runId: 'run-1',
      approvalVersion: 'version-1',
      title: '运行 Shell',
      reason: '需要执行构建命令。',
      permissionItems: [{
        itemId: 'item-1',
        capability: 'shell',
        targetLabel: 'npm run build',
        reason: '构建项目',
        risk: 'medium',
        approvalScopes: ['once']
      }],
      status,
      createdAt: '2026-07-22T00:00:01.000Z'
    }
  };
}
