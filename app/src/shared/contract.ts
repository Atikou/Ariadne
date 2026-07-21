export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const SYSTEM_CAPABILITIES = [
  'auto-launch',
  'wake.shortcut',
  'wake.voice',
  'wake.system',
  'window.attention',
  'game-activity'
] as const;

export type SystemCapability = (typeof SYSTEM_CAPABILITIES)[number];
export type CapabilityAvailability = 'available' | 'degraded' | 'unavailable';

export interface CapabilityStatus {
  capability: SystemCapability;
  availability: CapabilityAvailability;
  detail?: string;
}

export interface ClipboardWriteRequest {
  text: string;
}

export interface SavedLayout {
  schemaVersion: 1;
  layout: JsonObject;
  savedAt: string;
}

export interface SaveLayoutRequest {
  layout: JsonObject;
}

export interface SaveLayoutResult {
  savedAt: string;
}

export type ThemePreference = 'system' | 'dark' | 'light';
export type GameRuleKind = 'process-name' | 'process-path' | 'foreground-fullscreen';
export type GameRuleAction = 'suppress' | 'allow';

export interface GameDetectionRule {
  id: string;
  kind: GameRuleKind;
  pattern: string;
  action: GameRuleAction;
  enabled: boolean;
}

export interface UserPreferences {
  runInBackground: boolean;
  startAtLogin: boolean;
  theme: ThemePreference;
  suppressAutomaticWakeDuringGames: boolean;
  gameDetectionRules: GameDetectionRule[];
}

export type WakeSource = 'user' | 'shortcut' | 'voice' | 'system';

export interface ShowWindowRequest {
  source: WakeSource;
  allowTemporaryTopmost: boolean;
}

export interface ShowWindowResult {
  outcome: 'shown' | 'suppressed';
  reason?: string;
}

export interface GameActivitySnapshot {
  status: 'active' | 'inactive' | 'unknown';
  confidence: number;
  reason: string;
  observedAt: string;
}

export type TerminalShell = 'powershell' | 'cmd';

export interface CreateTerminalSessionRequest {
  sessionId: string;
  shell: TerminalShell;
  columns: number;
  rows: number;
}

export interface TerminalSession {
  id: string;
  shell: TerminalShell;
  cwd: string;
}

export interface WriteTerminalRequest {
  sessionId: string;
  data: string;
}

export interface ResizeTerminalRequest {
  sessionId: string;
  columns: number;
  rows: number;
}

export interface CloseTerminalRequest {
  sessionId: string;
}

export interface TerminalDataEvent {
  sessionId: string;
  data: string;
}

export interface TerminalExitEvent {
  sessionId: string;
  exitCode: number;
  signal?: number;
}

export interface WorkspaceDirectoryRequest {
  relativePath: string;
}

export interface WorkspaceEntry {
  name: string;
  relativePath: string;
  type: 'directory' | 'file';
}

export interface WorkspaceDirectoryListing {
  rootLabel: string;
  relativePath: string;
  entries: WorkspaceEntry[];
}

export interface AriadneApi {
  clipboard: {
    writeText(request: ClipboardWriteRequest): Promise<void>;
  };
  layout: {
    load(): Promise<SavedLayout | null>;
    save(request: SaveLayoutRequest): Promise<SaveLayoutResult>;
  };
  preferences: {
    load(): Promise<UserPreferences>;
    update(preferences: UserPreferences): Promise<UserPreferences>;
  };
  system: {
    getCapabilityStatuses(): Promise<CapabilityStatus[]>;
    getGameActivity(): Promise<GameActivitySnapshot>;
  };
  terminal: {
    create(request: CreateTerminalSessionRequest): Promise<TerminalSession>;
    write(request: WriteTerminalRequest): void;
    resize(request: ResizeTerminalRequest): void;
    close(request: CloseTerminalRequest): void;
    onData(listener: (event: TerminalDataEvent) => void): () => void;
    onExit(listener: (event: TerminalExitEvent) => void): () => void;
  };
  workspace: {
    listDirectory(request: WorkspaceDirectoryRequest): Promise<WorkspaceDirectoryListing>;
  };
  window: {
    hide(): Promise<void>;
    show(request: ShowWindowRequest): Promise<ShowWindowResult>;
    setTitleBarTheme(theme: Exclude<ThemePreference, 'system'>): Promise<void>;
  };
}
