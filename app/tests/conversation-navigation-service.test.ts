import { describe, expect, it } from 'vitest';
import type { AriadneApi } from '@shared/contract';
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
  it('projects the configured root as a selectable workspace folder', async () => {
    const service = createService(new MemoryStorage(), 'E:\\Project\\Ariadne');
    const workspaces = await service.listWorkspaces();

    expect(workspaces).toEqual([
      expect.objectContaining({ workspaceId: 'primary', name: 'Ariadne', rootPath: 'E:\\Project\\Ariadne' })
    ]);
    await expect(service.selectWorkspace(workspaces[0]!.workspaceId)).resolves.toBeUndefined();
    expect(service.getSelectedWorkspaceId()).toBe(workspaces[0]!.workspaceId);
  });

  it('persists explicit pin choices independently from Runtime session projection', async () => {
    const storage = new MemoryStorage();
    const first = createService(storage, '/projects/Ariadne');
    await first.listWorkspaces();
    first.setSessionPinned('session-1', true);

    const restored = createService(storage, '/projects/Ariadne');
    expect(restored.isSessionPinned('session-1', false)).toBe(true);
    restored.setSessionPinned('session-1', false);
    expect(restored.isSessionPinned('session-1', true)).toBe(false);
  });

  it('extracts folder names without depending on Node path APIs in Renderer', () => {
    expect(workspaceNameFromPath('E:\\Project\\Ariadne\\')).toBe('Ariadne');
    expect(workspaceNameFromPath('/projects/LittleLives/')).toBe('LittleLives');
  });

  it('opens a native-selected directory and makes it the selected workspace', async () => {
    const service = createService(
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
      expect.objectContaining({ workspaceId: 'primary', rootPath: 'E:\\Project\\Ariadne' }),
      expect.objectContaining({ workspaceId: 'workspace-opened', rootPath: 'E:\\Project\\LittleLives' })
    ]);
  });

  it('notifies shared desktop modules when the selected workspace changes', async () => {
    const service = createService(
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

  it('selects an already opened path without adding a duplicate workspace', async () => {
    const service = createService(
      new MemoryStorage(),
      'E:\\Project\\Ariadne',
      'e:\\project\\ariadne\\'
    );
    await service.listWorkspaces();

    await expect(service.openWorkspace()).resolves.toEqual(expect.objectContaining({ workspaceId: 'primary' }));
    await expect(service.listWorkspaces()).resolves.toHaveLength(1);
  });
});

function createService(
  storage: MemoryStorage,
  workspaceRoot: string,
  openedRoot: string | null = null
): ConfiguredConversationNavigationService {
  const catalog = [{ workspaceId: 'primary', rootPath: workspaceRoot, access: 'write' as const }];
  const agentSettings = {
    load: async () => ({ workspaceRoot, workspaces: catalog })
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
  return new ConfiguredConversationNavigationService(agentSettings, workspace, storage);
}

function normalizeRoot(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase();
}
