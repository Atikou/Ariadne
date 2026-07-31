import type { AgentSettingsView, AriadneApi } from '@shared/contract';

const NAVIGATION_STORAGE_KEY = 'ariadne.conversation-navigation.v1';
const INTERNAL_DEFAULT_WORKSPACE_ID = 'primary';

export interface ConversationWorkspace {
  workspaceId: string;
  name: string;
  rootPath: string;
  pinned: boolean;
  archivedAt?: string;
  purgeAfter?: string;
  purgedAt?: string;
}

export interface ConversationNavigationService {
  listWorkspaces(): Promise<readonly ConversationWorkspace[]>;
  listArchivedWorkspaces(): Promise<readonly ConversationWorkspace[]>;
  openWorkspace(): Promise<ConversationWorkspace | null>;
  getSelectedWorkspaceId(): string | null;
  onSelectedWorkspaceChanged(listener: (workspaceId: string | null) => void): () => void;
  onWorkspacesChanged(listener: (workspaces: readonly ConversationWorkspace[]) => void): () => void;
  selectWorkspace(workspaceId: string): Promise<void>;
  isWorkspaceActive(workspaceId: string): boolean;
  isAssistantWorkspace(workspaceId: string): boolean;
  setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<void>;
  archiveWorkspace(workspaceId: string): Promise<void>;
  restoreWorkspace(workspaceId: string): Promise<void>;
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
  private readonly workspaceListeners = new Set<(workspaces: readonly ConversationWorkspace[]) => void>();

  constructor(
    private readonly agentSettings: AriadneApi['agentSettings'],
    private readonly workspace: AriadneApi['workspace'],
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'>
  ) {
    this.state = readStoredNavigation(storage);
    if (typeof this.agentSettings.onWorkspacesChanged === 'function') {
      this.agentSettings.onWorkspacesChanged((settings) => this.applySettings(settings));
    }
  }

  listWorkspaces(): Promise<readonly ConversationWorkspace[]> {
    return this.loadCatalog().then(() => this.visibleWorkspaces());
  }

  listArchivedWorkspaces(): Promise<readonly ConversationWorkspace[]> {
    return this.loadCatalog().then(() => this.workspaces.filter((workspace) => workspace.archivedAt));
  }

  private loadCatalog(): Promise<readonly ConversationWorkspace[]> {
    if (this.catalogLoad) return this.catalogLoad;
    const operation = this.agentSettings.load()
      .then((settings) => {
        this.applySettings(settings);
        return this.workspaces;
      })
      .finally(() => {
        if (this.catalogLoad === operation) this.catalogLoad = undefined;
      });
    this.catalogLoad = operation;
    return operation;
  }

  private applySettings(settings: Pick<AgentSettingsView, 'workspaces'>): void {
    const previousSelectedWorkspaceId = this.getSelectedWorkspaceId();
    this.workspaces = settings.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspaceNameFromPath(workspace.rootPath),
      rootPath: workspace.rootPath,
      pinned: workspace.pinned === true,
      ...(workspace.archivedAt ? { archivedAt: workspace.archivedAt } : {}),
      ...(workspace.purgeAfter ? { purgeAfter: workspace.purgeAfter } : {}),
      ...(workspace.purgedAt ? { purgedAt: workspace.purgedAt } : {})
    }));
    this.catalogLoaded = true;
    if (!this.activeWorkspaces().some((candidate) => candidate.workspaceId === this.state.selectedWorkspaceId)) {
      this.state = {
        ...this.state,
        selectedWorkspaceId: this.visibleWorkspaces()[0]?.workspaceId
          ?? this.activeWorkspaces().find((workspace) => workspace.workspaceId === INTERNAL_DEFAULT_WORKSPACE_ID)?.workspaceId
          ?? null
      };
      this.persist();
    }
    if (previousSelectedWorkspaceId !== this.getSelectedWorkspaceId()) {
      this.notifySelectedWorkspaceChanged();
    }
    this.notifyWorkspacesChanged();
  }

  async openWorkspace(): Promise<ConversationWorkspace | null> {
    const opened = await this.workspace.openDirectory();
    if (!opened) return null;
    await this.loadCatalog();
    const workspace = this.workspaces.find((candidate) => candidate.workspaceId === opened.workspaceId)
      ?? this.workspaces.find((candidate) => sameWorkspaceRoot(candidate.rootPath, opened.rootPath))
      ?? null;
    if (workspace?.archivedAt) {
      throw new Error('该工作区已归档，请在设置中恢复后再打开。');
    }
    if (workspace) await this.selectWorkspace(workspace.workspaceId);
    return workspace;
  }

  getSelectedWorkspaceId(): string | null {
    if (!this.catalogLoaded) return null;
    return this.activeWorkspaces().some((workspace) => workspace.workspaceId === this.state.selectedWorkspaceId)
      ? this.state.selectedWorkspaceId
      : null;
  }

  onSelectedWorkspaceChanged(listener: (workspaceId: string | null) => void): () => void {
    this.selectedWorkspaceListeners.add(listener);
    listener(this.getSelectedWorkspaceId());
    return () => this.selectedWorkspaceListeners.delete(listener);
  }

  onWorkspacesChanged(listener: (workspaces: readonly ConversationWorkspace[]) => void): () => void {
    this.workspaceListeners.add(listener);
    listener(this.visibleWorkspaces());
    return () => this.workspaceListeners.delete(listener);
  }

  async selectWorkspace(workspaceId: string): Promise<void> {
    if (!this.activeWorkspaces().some((workspace) => workspace.workspaceId === workspaceId)) {
      throw new Error('工作区不存在、尚未加载或已经归档。');
    }
    this.setSelectedWorkspaceId(workspaceId);
  }

  isWorkspaceActive(workspaceId: string): boolean {
    return this.activeWorkspaces().some((workspace) => workspace.workspaceId === workspaceId);
  }

  isAssistantWorkspace(workspaceId: string): boolean {
    return workspaceId === INTERNAL_DEFAULT_WORKSPACE_ID;
  }

  async setWorkspacePinned(workspaceId: string, pinned: boolean): Promise<void> {
    this.applySettings(await this.agentSettings.setWorkspacePinned({ workspaceId, pinned }));
  }

  async archiveWorkspace(workspaceId: string): Promise<void> {
    this.applySettings(await this.agentSettings.archiveWorkspace({ workspaceId }));
  }

  async restoreWorkspace(workspaceId: string): Promise<void> {
    this.applySettings(await this.agentSettings.restoreWorkspace({ workspaceId }));
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

  private activeWorkspaces(): readonly ConversationWorkspace[] {
    return this.workspaces.filter((workspace) => !workspace.archivedAt);
  }

  private visibleWorkspaces(): readonly ConversationWorkspace[] {
    return this.activeWorkspaces()
      .filter((workspace) => workspace.workspaceId !== INTERNAL_DEFAULT_WORKSPACE_ID)
      .sort((left, right) => Number(right.pinned) - Number(left.pinned));
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

  private notifyWorkspacesChanged(): void {
    const workspaces = this.visibleWorkspaces();
    for (const listener of this.workspaceListeners) {
      try {
        listener(workspaces);
      } catch (error) {
        console.error('Workspace catalog observer failed.', error);
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
