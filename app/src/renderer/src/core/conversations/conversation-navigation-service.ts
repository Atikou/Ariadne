import type { AriadneApi } from '@shared/contract';

const NAVIGATION_STORAGE_KEY = 'ariadne.conversation-navigation.v1';

export interface ConversationWorkspace {
  workspaceId: string;
  name: string;
  rootPath: string;
}

export interface ConversationNavigationService {
  listWorkspaces(): Promise<readonly ConversationWorkspace[]>;
  openWorkspace(): Promise<ConversationWorkspace | null>;
  getSelectedWorkspaceId(): string | null;
  onSelectedWorkspaceChanged(listener: (workspaceId: string | null) => void): () => void;
  selectWorkspace(workspaceId: string): Promise<void>;
  isSessionPinned(sessionId: string, runtimePinned: boolean): boolean;
  setSessionPinned(sessionId: string, pinned: boolean): void;
}

interface StoredConversationNavigation {
  schemaVersion: 1;
  selectedWorkspaceId: string | null;
  pinOverrides: Record<string, boolean>;
}

export class ConfiguredConversationNavigationService implements ConversationNavigationService {
  private workspaces: readonly ConversationWorkspace[] = [];
  private catalogLoaded = false;
  private catalogLoad: Promise<readonly ConversationWorkspace[]> | undefined;
  private state: StoredConversationNavigation;
  private readonly selectedWorkspaceListeners = new Set<(workspaceId: string | null) => void>();

  constructor(
    private readonly agentSettings: AriadneApi['agentSettings'],
    private readonly workspace: AriadneApi['workspace'],
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  ) {
    this.state = readStoredNavigation(storage);
  }

  listWorkspaces(): Promise<readonly ConversationWorkspace[]> {
    if (this.catalogLoad) return this.catalogLoad;
    const operation = this.loadWorkspaces().finally(() => {
      if (this.catalogLoad === operation) this.catalogLoad = undefined;
    });
    this.catalogLoad = operation;
    return operation;
  }

  private async loadWorkspaces(): Promise<readonly ConversationWorkspace[]> {
    const previousSelectedWorkspaceId = this.getSelectedWorkspaceId();
    const settings = await this.agentSettings.load();
    this.workspaces = settings.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspaceNameFromPath(workspace.rootPath),
      rootPath: workspace.rootPath
    }));
    this.catalogLoaded = true;
    if (!this.state.selectedWorkspaceId
      || !this.workspaces.some((candidate) => candidate.workspaceId === this.state.selectedWorkspaceId)) {
      this.state = { ...this.state, selectedWorkspaceId: this.workspaces[0]?.workspaceId ?? null };
      this.persist();
    }
    if (previousSelectedWorkspaceId !== this.getSelectedWorkspaceId()) this.notifySelectedWorkspaceChanged();
    return this.workspaces;
  }

  async openWorkspace(): Promise<ConversationWorkspace | null> {
    const opened = await this.workspace.openDirectory();
    if (!opened) return null;
    const workspaces = await this.listWorkspaces();
    const workspace = workspaces.find((candidate) => candidate.workspaceId === opened.workspaceId)
      ?? workspaces.find((candidate) => sameWorkspaceRoot(candidate.rootPath, opened.rootPath))
      ?? null;
    if (workspace) await this.selectWorkspace(workspace.workspaceId);
    return workspace;
  }

  getSelectedWorkspaceId(): string | null {
    if (!this.catalogLoaded) return null;
    return this.workspaces.some((workspace) => workspace.workspaceId === this.state.selectedWorkspaceId)
      ? this.state.selectedWorkspaceId
      : null;
  }

  onSelectedWorkspaceChanged(listener: (workspaceId: string | null) => void): () => void {
    this.selectedWorkspaceListeners.add(listener);
    listener(this.getSelectedWorkspaceId());
    return () => this.selectedWorkspaceListeners.delete(listener);
  }

  async selectWorkspace(workspaceId: string): Promise<void> {
    if (!this.workspaces.some((workspace) => workspace.workspaceId === workspaceId)) {
      throw new Error('工作区不存在或尚未加载。');
    }
    this.setSelectedWorkspaceId(workspaceId);
  }

  isSessionPinned(sessionId: string, runtimePinned: boolean): boolean {
    return this.state.pinOverrides[sessionId] ?? runtimePinned;
  }

  setSessionPinned(sessionId: string, pinned: boolean): void {
    this.state = {
      ...this.state,
      pinOverrides: { ...this.state.pinOverrides, [sessionId]: pinned }
    };
    this.persist();
  }

  private persist(): void {
    try {
      this.storage.setItem(NAVIGATION_STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Navigation metadata is non-critical; Runtime sessions remain authoritative.
    }
  }

  private setSelectedWorkspaceId(workspaceId: string | null): void {
    if (this.getSelectedWorkspaceId() === workspaceId) return;
    this.state = { ...this.state, selectedWorkspaceId: workspaceId };
    this.persist();
    this.notifySelectedWorkspaceChanged();
  }

  private notifySelectedWorkspaceChanged(): void {
    const workspaceId = this.getSelectedWorkspaceId();
    for (const listener of this.selectedWorkspaceListeners) {
      try {
        listener(workspaceId);
      } catch (error) {
        console.error('Workspace selection observer failed.', error);
      }
    }
  }
}

function sameWorkspaceRoot(left: string, right: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

export function workspaceNameFromPath(rootPath: string): string {
  const normalized = rootPath.trim().replace(/[\\/]+$/, '');
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? '当前工作区';
}

function readStoredNavigation(storage: Pick<Storage, 'getItem' | 'setItem'>): StoredConversationNavigation {
  const fallback: StoredConversationNavigation = {
    schemaVersion: 1,
    selectedWorkspaceId: null,
    pinOverrides: {}
  };
  try {
    const raw = storage.getItem(NAVIGATION_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredNavigation(parsed)) return fallback;
    return parsed;
  } catch {
    return fallback;
  }
}

function isStoredNavigation(value: unknown): value is StoredConversationNavigation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredConversationNavigation>;
  if (candidate.schemaVersion !== 1) return false;
  if (candidate.selectedWorkspaceId !== null && typeof candidate.selectedWorkspaceId !== 'string') return false;
  if (!candidate.pinOverrides || typeof candidate.pinOverrides !== 'object') return false;
  const entries = Object.entries(candidate.pinOverrides);
  return entries.length <= 5_000
    && entries.every(([sessionId, pinned]) => sessionId.length > 0 && sessionId.length <= 512 && typeof pinned === 'boolean');
}
