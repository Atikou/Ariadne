import { describe, expect, it } from 'vitest';
import type { AgentSettingsView, AriadneApi } from '@shared/contract';
import {
  ConfiguredConversationNavigationService,
  workspaceNameFromPath
} from '../src/renderer/src/core/conversations/conversation-navigation-service';

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('ConversationNavigationService', () => {
  it('keeps the default conversation directory internal instead of rendering a workspace row', async () => {
    const service = createService(new MemoryStorage(), 'E:\\Project\\Ariadne').service;

    await expect(service.listWorkspaces()).resolves.toEqual([]);
    await expect(service.listSelectableWorkspaces()).resolves.toEqual([
      expect.objectContaining({ workspaceId: 'primary', name: 'Ariadne' })
    ]);
    expect(service.getSelectedWorkspaceId()).toBe('primary');
    expect(service.isAssistantWorkspace('primary')).toBe(true);
    expect(service.isAssistantWorkspace('workspace-opened')).toBe(false);
  });

  it('persists explicit session pin choices independently from Runtime session projection', async () => {
    const storage = new MemoryStorage();
    const first = createService(storage, '/projects/Ariadne').service;
    await first.listWorkspaces();
    first.setSessionPinned('session-1', true);

    const restored = createService(storage, '/projects/Ariadne').service;
    expect(restored.isSessionPinned('session-1', false)).toBe(true);
    restored.setSessionPinned('session-1', false);
    expect(restored.isSessionPinned('session-1', true)).toBe(false);
  });

  it('owns persistent session presentation actions and publishes one revision per change', () => {
    const storage = new MemoryStorage();
    const first = createService(storage, '/projects/Ariadne').service;
    const revisions: number[] = [];
    first.onSessionPresentationChanged(() => revisions.push(first.getSessionPresentationRevision()));

    first.renameSession('session-1', '新的聊天名称');
    first.setSessionPinned('session-1', true);
    first.setSessionUnread('session-1', true);
    first.archiveSession('session-1');

    expect(revisions).toEqual([1, 2, 3, 4]);
    expect(first.sessionTitle('session-1', 'Conversation')).toBe('新的聊天名称');
    expect(first.isSessionPinned('session-1', false)).toBe(true);
    expect(first.isSessionUnread('session-1')).toBe(false);
    expect(first.isSessionArchived('session-1')).toBe(true);

    const restored = createService(storage, '/projects/Ariadne').service;
    expect(restored.sessionTitle('session-1', 'Conversation')).toBe('新的聊天名称');
    expect(restored.isSessionPinned('session-1', false)).toBe(true);
    expect(restored.isSessionArchived('session-1')).toBe(true);
    restored.restoreSession('session-1');
    expect(restored.isSessionArchived('session-1')).toBe(false);
  });

  it('migrates v1 pin overrides into the single session presentation record', () => {
    const storage = new MemoryStorage();
    storage.setItem('ariadne.conversation-navigation.v1', JSON.stringify({
      schemaVersion: 1,
      selectedWorkspaceId: null,
      pinOverrides: { 'session-legacy': true }
    }));

    const service = createService(storage, '/projects/Ariadne').service;
    expect(service.isSessionPinned('session-legacy', false)).toBe(true);
    expect(service.sessionTitle('session-legacy', 'Conversation')).toBe('Conversation');
  });

  it('extracts folder names without depending on Node path APIs in Renderer', () => {
    expect(workspaceNameFromPath('E:\\Project\\Ariadne\\')).toBe('Ariadne');
    expect(workspaceNameFromPath('/projects/LittleLives/')).toBe('LittleLives');
  });

  it('opens a native-selected directory as a visible top-level workspace', async () => {
    const { service } = createService(
      new MemoryStorage(),
      'E:\\Project\\Ariadne',
      'E:\\Project\\LittleLives'
    );
    await service.listWorkspaces();

    await expect(service.openWorkspace()).resolves.toEqual(expect.objectContaining({
      workspaceId: 'workspace-opened',
      name: 'LittleLives',
      rootPath: 'E:\\Project\\LittleLives'
    }));
    expect(service.getSelectedWorkspaceId()).toBe('workspace-opened');
    await expect(service.listWorkspaces()).resolves.toEqual([
      expect.objectContaining({ workspaceId: 'workspace-opened', rootPath: 'E:\\Project\\LittleLives' })
    ]);
  });

  it('notifies shared desktop modules when the selected workspace changes', async () => {
    const { service } = createService(
      new MemoryStorage(),
      'E:\\Project\\Ariadne',
      'E:\\Project\\LittleLives'
    );
    const observed: Array<string | null> = [];
    const unsubscribe = service.onSelectedWorkspaceChanged((workspaceId) => observed.push(workspaceId));

    await service.listWorkspaces();
    await service.openWorkspace();
    unsubscribe();
    await service.selectWorkspace('primary');

    expect(observed).toEqual([null, 'primary', 'workspace-opened']);
  });

  it('persists workspace pin, archive and restore state through the settings authority', async () => {
    const { service } = createService(
      new MemoryStorage(),
      'E:\\Project\\Ariadne',
      'E:\\Project\\LittleLives'
    );
    const opened = await service.openWorkspace();
    if (!opened) throw new Error('fixture workspace was not opened');

    await service.setWorkspacePinned(opened.workspaceId, true);
    await expect(service.listWorkspaces()).resolves.toEqual([
      expect.objectContaining({ workspaceId: opened.workspaceId, pinned: true })
    ]);

    await service.archiveWorkspace(opened.workspaceId);
    await expect(service.listWorkspaces()).resolves.toEqual([]);
    await expect(service.listArchivedWorkspaces()).resolves.toEqual([
      expect.objectContaining({ workspaceId: opened.workspaceId, archivedAt: expect.any(String) })
    ]);

    await service.restoreWorkspace(opened.workspaceId);
    await expect(service.listWorkspaces()).resolves.toEqual([
      expect.objectContaining({ workspaceId: opened.workspaceId })
    ]);
  });

  it('selects an already opened path without adding a duplicate workspace', async () => {
    const { service, catalog } = createService(
      new MemoryStorage(),
      'E:\\Project\\Ariadne',
      'e:\\project\\ariadne\\'
    );
    await service.listWorkspaces();

    await expect(service.openWorkspace()).resolves.toEqual(expect.objectContaining({ workspaceId: 'primary' }));
    expect(catalog).toHaveLength(1);
    await expect(service.listWorkspaces()).resolves.toHaveLength(0);
  });
});

function createService(
  storage: MemoryStorage,
  workspaceRoot: string,
  openedRoot: string | null = null
): {
  service: ConfiguredConversationNavigationService;
  catalog: AgentSettingsView['workspaces'];
} {
  const catalog: AgentSettingsView['workspaces'] = [{
    workspaceId: 'primary',
    rootPath: workspaceRoot,
    access: 'write'
  }];
  const settings = (): AgentSettingsView => ({
    schemaVersion: 3,
    revision: 1,
    routingStrategy: 'cloud-first',
    permissionMode: 'request',
    customPermissions: {
      approvalPolicy: 'risk-based',
      sandboxMode: 'workspace-write',
      allowedPermissions: ['read', 'write', 'shell', 'network', 'dangerous']
    },
    workspaceRoot,
    workspaceAccess: 'write',
    workspaces: catalog.map((workspace) => ({ ...workspace })),
    localModelRoots: [],
    providers: {} as AgentSettingsView['providers'],
    runtimePolicy: {} as AgentSettingsView['runtimePolicy']
  });
  const agentSettings = {
    load: async () => settings(),
    apply: async () => ({ ok: true as const, settings: settings(), effect: 'hot_applied' as const }),
    setWorkspacePinned: async ({ workspaceId, pinned }: { workspaceId: string; pinned: boolean }) => {
      const workspace = requireWorkspace(catalog, workspaceId);
      if (pinned) workspace.pinned = true;
      else delete workspace.pinned;
      return settings();
    },
    archiveWorkspace: async ({ workspaceId }: { workspaceId: string }) => {
      const workspace = requireWorkspace(catalog, workspaceId);
      workspace.archivedAt = '2026-07-30T00:00:00.000Z';
      delete workspace.pinned;
      return settings();
    },
    restoreWorkspace: async ({ workspaceId }: { workspaceId: string }) => {
      const workspace = requireWorkspace(catalog, workspaceId);
      delete workspace.archivedAt;
      return settings();
    },
    onWorkspacesChanged: () => () => undefined
  } as AriadneApi['agentSettings'];
  const workspace = {
    openDirectory: async () => {
      if (!openedRoot) return null;
      const existing = catalog.find((candidate) => normalizeRoot(candidate.rootPath) === normalizeRoot(openedRoot));
      if (existing) return { workspaceId: existing.workspaceId, rootPath: existing.rootPath };
      const opened = { workspaceId: 'workspace-opened', rootPath: openedRoot, access: 'write' as const };
      catalog.push(opened);
      return { workspaceId: opened.workspaceId, rootPath: opened.rootPath };
    }
  } as AriadneApi['workspace'];
  return {
    service: new ConfiguredConversationNavigationService(agentSettings, workspace, storage),
    catalog
  };
}

function requireWorkspace(
  catalog: AgentSettingsView['workspaces'],
  workspaceId: string
): AgentSettingsView['workspaces'][number] {
  const workspace = catalog.find((candidate) => candidate.workspaceId === workspaceId);
  if (!workspace) throw new Error('workspace missing');
  return workspace;
}

function normalizeRoot(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase();
}
