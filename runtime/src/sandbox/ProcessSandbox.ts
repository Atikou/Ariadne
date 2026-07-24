import type {
  SandboxExecutionResult,
  SandboxMode,
  SandboxNetworkMode,
  SandboxResourceLimits,
} from "./SandboxContracts.js";

export interface SandboxProcessRequest {
  cwd: string;
  workspaceRoot: string;
  /** Trusted per-session write capability. Callers must not construct this directly. */
  writeScope?: {
    scopeId: string;
    root: string;
  };
  writableRoots?: string[];
  readOnlySubpaths?: string[];
  mode?: SandboxMode;
  networkMode?: SandboxNetworkMode;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  stdin?: string | Buffer;
  environment?: Readonly<Record<string, string>>;
  resourceLimits?: Partial<SandboxResourceLimits>;
}

export interface SandboxShellRequest extends SandboxProcessRequest {
  command: string;
}

export interface SandboxFileRequest extends SandboxProcessRequest {
  file: string;
  args?: string[];
}

export interface SandboxProcessObserver {
  onStarted?(input: { executionId: string; pid?: number }): void;
  onStdout?(chunk: Buffer): void;
  onStderr?(chunk: Buffer): void;
}

export interface SandboxProcessHandle {
  readonly executionId: string;
  readonly completion: Promise<SandboxExecutionResult>;
  cancel(): void;
}

export interface ProcessSandbox {
  readonly mode: SandboxMode;
  startShell(input: SandboxShellRequest, observer?: SandboxProcessObserver): SandboxProcessHandle;
  startFile(input: SandboxFileRequest, observer?: SandboxProcessObserver): SandboxProcessHandle;
  runShell(input: SandboxShellRequest): Promise<SandboxExecutionResult>;
  runFile(input: SandboxFileRequest): Promise<SandboxExecutionResult>;
}

export function requireProcessSandbox(
  processSandbox: ProcessSandbox | undefined,
): ProcessSandbox {
  if (processSandbox) return processSandbox;
  throw new Error("sandbox_unavailable: process sandbox broker was not injected");
}
