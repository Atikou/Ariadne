export type AgentProcessSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type AgentProcessNetworkMode = 'offline' | 'online-approved';

export interface AgentProcessIsolationEvidence {
  readonly backend: 'windows-native' | 'host';
  readonly enforced: boolean;
  readonly mode: AgentProcessSandboxMode;
  readonly networkMode: AgentProcessNetworkMode;
  readonly [key: string]: unknown;
}

export interface AgentProcessExecutionResult {
  readonly executionId: string;
  readonly exitCode?: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly spawnFailed: boolean;
  readonly errorCode?: string;
  readonly isolation: AgentProcessIsolationEvidence;
}

export interface AgentProcessRequest {
  readonly file: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly mode?: AgentProcessSandboxMode;
  readonly networkMode?: AgentProcessNetworkMode;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly environment?: Readonly<Record<string, string>>;
}

export interface AgentProcessObserver {
  onStarted?(input: { readonly executionId: string; readonly pid?: number }): void;
  onStdout?(chunk: Buffer): void;
  onStderr?(chunk: Buffer): void;
}

export interface AgentProcessLease {
  readonly executionId: string;
  readonly completion: Promise<AgentProcessExecutionResult>;
  cancel(): void;
  writeStdin(chunk: string | Buffer): Promise<void>;
  endStdin(): Promise<void>;
}

export interface AgentProcessSandbox {
  readonly mode: AgentProcessSandboxMode;
  runFile(input: AgentProcessRequest): Promise<AgentProcessExecutionResult>;
  openFileLease(input: AgentProcessRequest, observer?: AgentProcessObserver): AgentProcessLease;
}

export interface AgentProcessSandboxFactoryInput {
  readonly workspaceRoot: string;
  readonly installRoot: string;
  readonly production: boolean;
  readonly mode: AgentProcessSandboxMode;
  readonly allowedPermissions: readonly ('read' | 'write' | 'shell' | 'network' | 'dangerous')[];
}

export type AgentProcessSandboxFactory = (
  input: AgentProcessSandboxFactoryInput
) => AgentProcessSandbox;
