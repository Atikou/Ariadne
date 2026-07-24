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

export const AGENT_PROVIDER_IDS = ['openai', 'deepseek', 'kimi', 'anthropic'] as const;
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];
export type AgentProviderProtocol = 'openai-compatible' | 'anthropic-messages';

export interface AgentProviderDefinition {
  id: AgentProviderId;
  label: string;
  runtimeModelId: string;
  protocol: AgentProviderProtocol;
  apiKeyEnvironmentVariable: string;
  apiKeyLabel: string;
  defaultBaseUrl: string;
  defaultModel: string;
  defaultInference: ModelInferenceProfile;
}

/**
 * Provider 身份、传输协议与默认配置的唯一注册表。
 * 新增远程 Provider 时，桌面设置、Runtime bootstrap 与凭据映射都从这里派生。
 */
export const AGENT_PROVIDER_CATALOG = {
  openai: {
    id: 'openai',
    label: 'OpenAI',
    runtimeModelId: 'cloud-openai',
    protocol: 'openai-compatible',
    apiKeyEnvironmentVariable: 'OPENAI_API_KEY',
    apiKeyLabel: 'OpenAI API Key',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    defaultInference: {}
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    runtimeModelId: 'cloud-deepseek',
    protocol: 'openai-compatible',
    apiKeyEnvironmentVariable: 'DEEPSEEK_API_KEY',
    apiKeyLabel: 'DeepSeek API Key',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    defaultInference: {
      reasoning: {
        modes: ['off', 'on'],
        defaultMode: 'on',
        efforts: ['high', 'max'],
        defaultEffort: 'high'
      }
    }
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi',
    runtimeModelId: 'cloud-kimi',
    protocol: 'openai-compatible',
    apiKeyEnvironmentVariable: 'MOONSHOT_API_KEY',
    apiKeyLabel: 'Kimi API Key',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    defaultInference: {
      reasoning: {
        modes: ['on'],
        defaultMode: 'on',
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'max'
      }
    }
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    runtimeModelId: 'cloud-anthropic',
    protocol: 'anthropic-messages',
    apiKeyEnvironmentVariable: 'ANTHROPIC_API_KEY',
    apiKeyLabel: 'Anthropic API Key',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    defaultInference: {}
  }
} as const satisfies Record<AgentProviderId, AgentProviderDefinition>;

export type AgentRoutingStrategy = 'local-first' | 'cloud-first' | 'privacy-first' | 'quality-first';
export type ApiKeyStatus = 'missing' | 'configured' | 'unavailable';
export const AGENT_PERMISSION_MODES = ['request', 'risk-based', 'full-access', 'custom'] as const;
export type AgentPermissionMode = (typeof AGENT_PERMISSION_MODES)[number];
export const AGENT_APPROVAL_POLICIES = ['request', 'risk-based', 'full-access'] as const;
export type AgentApprovalPolicy = (typeof AGENT_APPROVAL_POLICIES)[number];
export const AGENT_SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'] as const;
export type AgentSandboxMode = (typeof AGENT_SANDBOX_MODES)[number];
export const AGENT_TOOL_PERMISSIONS = ['read', 'write', 'shell', 'network', 'dangerous'] as const;
export type AgentToolPermission = (typeof AGENT_TOOL_PERMISSIONS)[number];

export interface AgentCustomPermissions {
  approvalPolicy: AgentApprovalPolicy;
  sandboxMode: AgentSandboxMode;
  allowedPermissions: AgentToolPermission[];
}

export interface AgentProviderSettingsView {
  enabled: boolean;
  baseUrl: string;
  model: string;
  inference: ModelInferenceProfile;
  apiKeyStatus: ApiKeyStatus;
}

export interface AgentSettingsView {
  schemaVersion: 2;
  routingStrategy: AgentRoutingStrategy;
  permissionMode: AgentPermissionMode;
  customPermissions: AgentCustomPermissions;
  workspaceRoot: string;
  workspaceAccess: 'read' | 'write';
  workspaces: AgentWorkspaceSettingsView[];
  localModelRoots: string[];
  providers: Record<AgentProviderId, AgentProviderSettingsView>;
  runtimePolicy: RuntimePolicySnapshot;
}

export interface AgentWorkspaceSettingsView {
  workspaceId: string;
  rootPath: string;
  access: 'read' | 'write';
}

export interface AgentProviderSettingsUpdate {
  enabled: boolean;
  baseUrl: string;
  model: string;
  inference: ModelInferenceProfile;
  apiKey?: string | undefined;
  clearApiKey: boolean;
}

export interface AgentSettingsUpdate {
  routingStrategy: AgentRoutingStrategy;
  permissionMode: AgentPermissionMode;
  customPermissions: AgentCustomPermissions;
  workspaceRoot: string;
  workspaceAccess: 'read' | 'write';
  localModelRoots: string[];
  providers: Record<AgentProviderId, AgentProviderSettingsUpdate>;
  runtimePolicy?: RuntimePolicySnapshot | undefined;
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
  workspaceId: string;
  shell: TerminalShell;
  columns: number;
  rows: number;
}

export interface TerminalSession {
  id: string;
  workspaceId: string;
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
  workspaceId: string;
  relativePath: string;
}

export interface WorkspaceEntry {
  name: string;
  relativePath: string;
  type: 'directory' | 'file';
}

export interface WorkspaceDirectoryListing {
  workspaceId: string;
  rootLabel: string;
  relativePath: string;
  entries: WorkspaceEntry[];
}

export interface OpenWorkspaceResult {
  workspaceId: string;
  rootPath: string;
}

export interface AriadneApi {
  agentSettings: {
    load(): Promise<AgentSettingsView>;
    update(settings: AgentSettingsUpdate): Promise<AgentSettingsView>;
  };
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
  runtime: {
    getStatus(): Promise<RuntimeStatus>;
    request(command: RuntimeCommand): Promise<RuntimeResult>;
    onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void;
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
    openDirectory(): Promise<OpenWorkspaceResult | null>;
    listDirectory(request: WorkspaceDirectoryRequest): Promise<WorkspaceDirectoryListing>;
  };
  window: {
    hide(): Promise<void>;
    show(request: ShowWindowRequest): Promise<ShowWindowResult>;
    setTitleBarTheme(theme: Exclude<ThemePreference, 'system'>): Promise<void>;
  };
}
import type {
  ModelInferenceProfile,
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResult,
  RuntimeStatus
} from '@ariadne/protocol/public';
import type { RuntimePolicySnapshot } from '@ariadne/protocol/settings';
