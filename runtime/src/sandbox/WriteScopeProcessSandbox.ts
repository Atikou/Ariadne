import path from "node:path";

import { canonicalizePathIdentity } from "../platform/pathIdentity.js";
import type {
  ProcessSandbox,
  SandboxFileRequest,
  SandboxProcessHandle,
  SandboxProcessObserver,
  SandboxProcessRequest,
  SandboxShellRequest,
} from "./ProcessSandbox.js";
import type { SandboxMode } from "./SandboxContracts.js";

/**
 * Narrows one Broker to an isolated child workspace. The native helper receives
 * the original policy root plus a trusted per-session write capability.
 */
export class WriteScopeProcessSandbox implements ProcessSandbox {
  readonly mode: SandboxMode;
  private readonly policyRoot: string;
  private readonly logicalWorkspaceRoot: string;
  private readonly scopeRoot: string;

  constructor(
    private readonly delegate: ProcessSandbox,
    policyRoot: string,
    logicalWorkspaceRoot: string,
    private readonly scopeId: string,
    scopeRoot: string,
  ) {
    if (!/^[0-9a-f]{32}$/u.test(scopeId)) throw new Error("invalid_subagent_write_scope_id");
    this.policyRoot = canonicalizePathIdentity(policyRoot);
    this.logicalWorkspaceRoot = canonicalizePathIdentity(logicalWorkspaceRoot);
    this.scopeRoot = canonicalizePathIdentity(scopeRoot);
    assertInside(this.logicalWorkspaceRoot, this.scopeRoot, "subagent_workspace_outside_write_scope");
    this.mode = delegate.mode;
  }

  startShell(input: SandboxShellRequest, observer?: SandboxProcessObserver): SandboxProcessHandle {
    return this.delegate.startShell(this.rewrite(input), observer);
  }

  startFile(input: SandboxFileRequest, observer?: SandboxProcessObserver): SandboxProcessHandle {
    return this.delegate.startFile(this.rewrite(input), observer);
  }

  runShell(input: SandboxShellRequest) {
    return this.startShell(input).completion;
  }

  runFile(input: SandboxFileRequest) {
    return this.startFile(input).completion;
  }

  private rewrite<T extends SandboxProcessRequest>(input: T): T {
    if (input.writeScope !== undefined || (input.writableRoots?.length ?? 0) > 0) {
      throw new Error("subagent_process_cannot_expand_write_scope");
    }
    const workspaceRoot = canonicalizePathIdentity(input.workspaceRoot);
    if (!pathEquals(workspaceRoot, this.logicalWorkspaceRoot)) {
      throw new Error("subagent_process_workspace_mismatch");
    }
    const cwd = canonicalizePathIdentity(input.cwd);
    assertInside(cwd, this.logicalWorkspaceRoot, "subagent_process_cwd_outside_workspace");
    for (const readOnlyPath of input.readOnlySubpaths ?? []) {
      assertInside(
        canonicalizePathIdentity(readOnlyPath),
        this.scopeRoot,
        "subagent_read_only_path_outside_write_scope",
      );
    }

    if (this.delegate.mode === "read-only") {
      throw new Error("subagent_write_scope_requires_workspace_write_sandbox");
    }
    const mode = this.delegate.mode === "danger-full-access"
      ? "danger-full-access"
      : input.mode ?? "workspace-write";
    if (mode === "danger-full-access" && this.delegate.mode !== "danger-full-access") {
      throw new Error("subagent_process_cannot_expand_sandbox_mode");
    }

    return {
      ...input,
      cwd,
      workspaceRoot: this.policyRoot,
      writableRoots: undefined,
      mode,
      writeScope: mode === "workspace-write"
        ? { scopeId: this.scopeId, root: this.scopeRoot }
        : undefined,
    };
  }
}

function assertInside(candidate: string, root: string, code: string): void {
  const relative = path.relative(root, candidate);
  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) {
    throw new Error(code);
  }
}

function pathEquals(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    : left === right;
}
