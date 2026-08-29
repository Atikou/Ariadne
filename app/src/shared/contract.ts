import type { LiveWorkOutputChunk, LiveWorkSnapshot } from '@ariadne/live-work';
import type {
  AcpSubagentProviderConfiguration,
  AssistantChatProfile
} from '@ariadne/protocol/settings';
export { createDefaultAssistantChatProfile } from '@ariadne/protocol/settings';

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const SYSTEM_CAPABILITIES = [
  'auto-launch',
  'speech.stt',
  'speech.tts',
  'speech.voice-pack',
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
  speech: SpeechPreferences;
}

export type ForegroundSttMode = 'compose' | 'auto-send';

export interface SpeechPreferences {
  enabled: boolean;
  moduleRoot: string;
  foregroundSttMode: ForegroundSttMode;
  backgroundWakeEnabled: boolean;
  wakeKeywords: string[];
  listenWhenLocked: boolean;
  inputDeviceId: string;
  outputDeviceId: string;
  activeVoiceId: string | null;
  activeVoiceVersion: string | null;
}

export type SpeechAvailability = 'available' | 'degraded' | 'disabled' | 'unavailable';
export type SpeechActivity = 'idle' | 'waking' | 'listening' | 'transcribing' | 'speaking' | 'error';

export interface SpeechDevice {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface SpeechVoiceSummary {
  voiceId: string;
  version: string;
  displayName: string;
  languages: string[];
  sampleRate: number;
  active: boolean;
}

export interface SpeechStatus {
  protocolVersion: 1;
  availability: SpeechAvailability;
  activity: SpeechActivity;
  detail: string;
  moduleRoot: string;
  capabilities: Array<'stt' | 'tts' | 'kws' | 'voice-pack'>;
  inputDevices: SpeechDevice[];
  outputDevices: SpeechDevice[];
  voices: SpeechVoiceSummary[];
}

export interface StartSpeechRecognitionRequest {
  requestId: string;
  source: 'foreground' | 'background-wake';
}

export interface StopSpeechRecognitionRequest {
  requestId: string;
}

export interface SpeechSynthesisSegmentRequest {
  turnId: string;
  sequence: number;
  text: string;
  final: boolean;
}

export interface CancelSpeechSynthesisRequest {
  turnId?: string | undefined;
}

export interface ActivateSpeechVoiceRequest {
  voiceId: string;
  version: string;
}

export interface VoicePackInstallResult {
  installed: boolean;
  voice: SpeechVoiceSummary | null;
  detail: string;
}

export type SpeechEvent =
  | { kind: 'status'; status: SpeechStatus }
  | { kind: 'wake'; keyword: string; observedAt: string }
  | { kind: 'transcript.partial'; requestId: string; text: string }
  | { kind: 'transcript.final'; requestId: string; text: string; source: 'foreground' | 'background-wake' }
  | { kind: 'tts.started'; turnId: string }
  | { kind: 'tts.segment-completed'; turnId: string; sequence: number }
  | { kind: 'tts.completed'; turnId: string }
  | { kind: 'tts.cancelled'; turnId: string | null }
  | { kind: 'error'; operation: string; message: string; retryable: boolean };

export const AGENT_PROVIDER_IDS = ['openai', 'deepseek', 'kimi', 'anthropic'] as const;
export type AgentProviderId = (typeof AGENT_PROVIDER_IDS)[number];
export type AgentProviderProtocol = 'openai-compatible' | 'anthropic-messages';

export interface AgentProviderDefinition {
  id: AgentProviderId;
  label: string;
  runtimeModelId: string;
  protocol: AgentProviderProtocol;
  usageReporting: 'none' | 'openai-stream-options' | 'anthropic-events';
  apiKeyEnvironmentVariable: string;
  apiKeyLabel: string;
  defaultBaseUrl: string;
  defaultModel: string;
  supportsVision: boolean;
  defaultContextWindowTokens: number;
  defaultMaxOutputTokens: number;
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
    usageReporting: 'openai-stream-options',
    apiKeyEnvironmentVariable: 'OPENAI_API_KEY',
    apiKeyLabel: 'OpenAI API Key',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    supportsVision: true,
    defaultContextWindowTokens: 128_000,
    defaultMaxOutputTokens: 16_384,
    defaultInference: {}
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    runtimeModelId: 'cloud-deepseek',
    protocol: 'openai-compatible',
    usageReporting: 'openai-stream-options',
    apiKeyEnvironmentVariable: 'DEEPSEEK_API_KEY',
    apiKeyLabel: 'DeepSeek API Key',
    defaultBaseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-flash',
    supportsVision: false,
    defaultContextWindowTokens: 128_000,
    defaultMaxOutputTokens: 8_192,
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
    usageReporting: 'openai-stream-options',
    apiKeyEnvironmentVariable: 'MOONSHOT_API_KEY',
    apiKeyLabel: 'Kimi API Key',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    supportsVision: false,
    defaultContextWindowTokens: 256_000,
    defaultMaxOutputTokens: 32_768,
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
    usageReporting: 'anthropic-events',
    apiKeyEnvironmentVariable: 'ANTHROPIC_API_KEY',
    apiKeyLabel: 'Anthropic API Key',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    supportsVision: true,
    defaultContextWindowTokens: 200_000,
    defaultMaxOutputTokens: 16_384,
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
  contextWindowTokens: number;
  maxOutputTokens: number;
  inference: ModelInferenceProfile;
  apiKeyStatus: ApiKeyStatus;
}

export interface AgentAcpSubagentProviderSettingsView
extends AcpSubagentProviderConfiguration {
  enabled: boolean;
}

export interface AgentSettingsView {
  schemaVersion: 7;
  revision: number;
  assistant: AssistantChatProfile;
  routingStrategy: AgentRoutingStrategy;
  permissionMode: AgentPermissionMode;
  customPermissions: AgentCustomPermissions;
  workspaceAccess: 'read' | 'write';
  workspaces: AgentWorkspaceSettingsView[];
  localModelRoots: string[];
  providers: Record<AgentProviderId, AgentProviderSettingsView>;
  subagentProviders: AgentAcpSubagentProviderSettingsView[];
  runtimePolicy: RuntimePolicySnapshot;
}

export interface AgentWorkspaceSettingsView {
  workspaceId: string;
  rootPath: string;
  access: 'read' | 'write';
  pinned?: true | undefined;
  archivedAt?: string | undefined;
}


export interface AgentWorkspaceRequest {
  workspaceId: string;
}

export interface AgentWorkspacePinUpdate extends AgentWorkspaceRequest {
  pinned: boolean;
}

export interface AgentProviderSettingsPatch {
  enabled?: boolean | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  contextWindowTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  inference?: ModelInferenceProfile | undefined;
  apiKey?: string | undefined;
  clearApiKey?: true | undefined;
}

export type AgentSettingsOperation =
  | {
      kind: 'permissions.set';
      mode: AgentPermissionMode;
      customPermissions?: AgentCustomPermissions | undefined;
    }
  | { kind: 'routing.set'; strategy: AgentRoutingStrategy }
  | { kind: 'assistant.replace'; assistant: AssistantChatProfile }
  | { kind: 'modelRoots.replace'; roots: string[] }
  | {
      kind: 'provider.update';
      providerId: AgentProviderId;
      patch: AgentProviderSettingsPatch;
    }
  | {
      kind: 'subagentProviders.replace';
      providers: AgentAcpSubagentProviderSettingsView[];
    }
  | { kind: 'runtimePolicy.replace'; policy: RuntimePolicySnapshot };

export interface AgentSettingsMutation {
  expectedRevision: number;
  operations: AgentSettingsOperation[];
}

export type AgentSettingsEffect = 'hot_applied' | 'reload_scheduled' | 'restart_required';

export type AgentSettingsMutationResult =
  | {
      ok: true;
      settings: AgentSettingsView;
      effect: AgentSettingsEffect;
    }
  | {
      ok: false;
      settings: AgentSettingsView;
      error: {
        code: 'settings_revision_conflict';
        message: string;
        expectedRevision: number;
        currentRevision: number;
      };
    };

export interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
  correlationId: string;
  details?: string[] | undefined;
}

export type Result<T, E = PublicError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export interface RuntimeDesktopRequestOptions {
  commandId?: string | undefined;
}

export type AgentInputDeliveryCommand = Extract<
  RuntimeCommand,
  { readonly kind: 'agent.inbox.enqueue.v3' }
>;

export interface AgentInputDeliveryOutboxRecord {
  commandId: string;
  command: AgentInputDeliveryCommand;
  createdAt: string;
}

export interface AgentInputDeliveryOutboxStageRequest {
  commandId: string;
  command: AgentInputDeliveryCommand;
}

export interface AgentInputDeliveryOutboxSettleRequest {
  commandId: string;
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
  restartOf?: string | undefined;
}

export interface TerminalRecoveryRecord {
  sessionId: string;
  workspaceId: string;
  shell: TerminalShell;
  status: 'running' | 'completed' | 'failed' | 'killed' | 'interrupted';
  startedAt: string;
  updatedAt: string;
  restartOf?: string | undefined;
  exitCode?: number | undefined;
  detail?: string | undefined;
}

export interface TerminalSession {
  id: string;
  workspaceId: string;
  shell: TerminalShell;
  cwd: string;
  work: LiveWorkSnapshot;
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

export interface SignalTerminalRequest {
  sessionId: string;
  signal: 'interrupt' | 'terminate' | 'kill';
}

export interface TerminalOutputEvent {
  sessionId: string;
  work: LiveWorkSnapshot;
  chunk: LiveWorkOutputChunk;
}

export interface TerminalExitEvent {
  sessionId: string;
  work: LiveWorkSnapshot;
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

export interface ApprovalNotificationTestResult {
  shown: boolean;
  supported: boolean;
}

export interface ApprovalNavigationRequest {
  sessionId: string;
}

export interface AriadneApi {
  agentSettings: {
    load(): Promise<AgentSettingsView>;
    apply(mutation: AgentSettingsMutation): Promise<AgentSettingsMutationResult>;
    setWorkspacePinned(request: AgentWorkspacePinUpdate): Promise<AgentSettingsView>;
    archiveWorkspace(request: AgentWorkspaceRequest): Promise<AgentSettingsView>;
    restoreWorkspace(request: AgentWorkspaceRequest): Promise<AgentSettingsView>;
    onWorkspacesChanged(listener: (settings: AgentSettingsView) => void): () => void;
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
    getStatus(): Promise<Result<RuntimeStatus>>;
    onStatus(listener: (status: RuntimeStatus) => void): () => void;
    request(
      command: RuntimeCommand,
      options?: RuntimeDesktopRequestOptions
    ): Promise<Result<RuntimeResult>>;
    onEvent(listener: (event: RuntimeEventEnvelope) => void): () => void;
  };
  agentInputDeliveryOutbox?: {
    list(): Promise<AgentInputDeliveryOutboxRecord[]>;
    stage(request: AgentInputDeliveryOutboxStageRequest): Promise<AgentInputDeliveryOutboxRecord>;
    settle(request: AgentInputDeliveryOutboxSettleRequest): Promise<void>;
  };
  speech: {
    getStatus(): Promise<SpeechStatus>;
    startRecognition(request: StartSpeechRecognitionRequest): Promise<void>;
    stopRecognition(request: StopSpeechRecognitionRequest): Promise<void>;
    cancelRecognition(): Promise<void>;
    synthesize(request: SpeechSynthesisSegmentRequest): Promise<void>;
    cancelSynthesis(request?: CancelSpeechSynthesisRequest): Promise<void>;
    importVoicePack(): Promise<VoicePackInstallResult | null>;
    activateVoice(request: ActivateSpeechVoiceRequest): Promise<SpeechVoiceSummary>;
    onEvent(listener: (event: SpeechEvent) => void): () => void;
  };
  system: {
    getCapabilityStatuses(): Promise<CapabilityStatus[]>;
    getGameActivity(): Promise<GameActivitySnapshot>;
    testApprovalNotification(): Promise<ApprovalNotificationTestResult>;
    onApprovalNavigation(listener: (request: ApprovalNavigationRequest) => void): () => void;
  };
  terminal: {
    listRecoveryRecords(): Promise<TerminalRecoveryRecord[]>;
    create(request: CreateTerminalSessionRequest): Promise<TerminalSession>;
    write(request: WriteTerminalRequest): void;
    resize(request: ResizeTerminalRequest): void;
    signal(request: SignalTerminalRequest): void;
    close(request: CloseTerminalRequest): void;
    onOutput(listener: (event: TerminalOutputEvent) => void): () => void;
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
