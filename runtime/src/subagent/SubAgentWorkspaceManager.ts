import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";
import type { SandboxExecutionResult, SandboxMode } from "../sandbox/SandboxContracts.js";
import { WriteScopeProcessSandbox } from "../sandbox/WriteScopeProcessSandbox.js";
import {
  SubAgentWorkspaceLeaseStore,
  type SubAgentWorkspaceLeaseHandle,
  type SubAgentWorkspaceRecoverySummary,
} from "./SubAgentWorkspaceLease.js";

const INTERNAL_TIMEOUT_MS = 30_000;
const INTERNAL_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = 100_000;

export interface SubAgentWorkspaceArtifact {
  kind: "isolated_snapshot";
  changedFiles: string[];
  unifiedDiff: string;
  diffTruncated: boolean;
  appliedToPrimary: false;
}

export class SubAgentWorkspaceSession {
  private disposed = false;

  constructor(
    readonly workspaceRoot: string,
    private readonly repositoryRoot: string,
    readonly processSandbox: ProcessSandbox,
    private readonly lease: SubAgentWorkspaceLeaseHandle,
  ) {}

  async collect(): Promise<SubAgentWorkspaceArtifact> {
    await this.git(["add", "-N", "--", "."]);
    const status = await this.git(["status", "--porcelain=v1", "--no-renames", "-z"]);
    const diff = await this.git(["diff", "--binary", "--no-ext-diff", "HEAD", "--"]);
    return {
      kind: "isolated_snapshot",
      changedFiles: parsePorcelainPaths(status.stdout),
      unifiedDiff: diff.stdout,
      diffTruncated: diff.truncated,
      appliedToPrimary: false,
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.lease.dispose();
  }

  private git(args: string[]) {
    return runGit(this.processSandbox, this.repositoryRoot, this.workspaceRoot, args);
  }
}

/** Creates an independent repository snapshot without mutating the primary repository metadata. */
export class SubAgentWorkspaceManager {
  constructor(
    private readonly processSandbox: ProcessSandbox,
    private readonly leaseStore = new SubAgentWorkspaceLeaseStore(),
  ) {}

  recoverOrphanedScopes(primaryWorkspaceRoots: readonly string[]): SubAgentWorkspaceRecoverySummary {
    const total: SubAgentWorkspaceRecoverySummary = {
      recoveredScopes: 0,
      preservedActiveScopes: 0,
      quarantinedEntries: 0,
    };
    const seen = new Set<string>();
    for (const root of primaryWorkspaceRoots) {
      let canonicalRoot: string;
      try {
        canonicalRoot = realpathSync.native(root);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw error;
      }
      const identity = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const recovered = this.leaseStore.recoverOrphanedScopes(canonicalRoot);
      total.recoveredScopes += recovered.recoveredScopes;
      total.preservedActiveScopes += recovered.preservedActiveScopes;
      total.quarantinedEntries += recovered.quarantinedEntries;
    }
    return total;
  }

  async create(primaryWorkspaceRoot: string, subAgentId: string): Promise<SubAgentWorkspaceSession> {
    if (this.processSandbox.mode === "read-only") {
      throw new Error("subagent_write_isolation_requires_workspace_write_sandbox");
    }
    const primaryReal = await realpath(primaryWorkspaceRoot);
    const repo = await runGit(
      this.processSandbox,
      primaryReal,
      primaryReal,
      ["rev-parse", "--show-toplevel"],
      "read-only",
    );
    const repoRoot = await realpath(repo.stdout.trim());
    const relativeWorkspace = path.relative(repoRoot, primaryReal);
    if (relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) {
      throw new Error("subagent_workspace_must_be_inside_git_repository");
    }

    const [tracked, untracked] = await Promise.all([
      runGit(this.processSandbox, primaryReal, primaryReal, ["ls-files", "--cached", "-z"], "read-only"),
      runGit(
        this.processSandbox,
        primaryReal,
        primaryReal,
        ["ls-files", "--others", "--exclude-standard", "-z"],
        "read-only",
      ),
    ]);
    const snapshotPaths = collectSnapshotPaths(tracked.stdout, untracked.stdout);
    const scopeId = randomBytes(16).toString("hex");
    const lease = await this.leaseStore.acquire({
      primaryWorkspaceRoot: primaryReal,
      scopeId,
      subAgentId,
    });
    const { scopeContainer, repositoryRoot } = lease.marker;

    try {
      await mkdir(repositoryRoot, { recursive: true });
      await copySnapshot(primaryReal, repositoryRoot, snapshotPaths);
      const workspaceRoot = repositoryRoot;

      const repositorySandbox = new WriteScopeProcessSandbox(
        this.processSandbox,
        primaryReal,
        repositoryRoot,
        scopeId,
        repositoryRoot,
      );
      await runGit(repositorySandbox, repositoryRoot, repositoryRoot, ["init"]);
      await runGit(repositorySandbox, repositoryRoot, repositoryRoot, ["add", "-A"]);
      await runGit(repositorySandbox, repositoryRoot, repositoryRoot, [
        "-c",
        "user.name=Ariadne Isolation",
        "-c",
        "user.email=ariadne@local.invalid",
        "commit",
        "--allow-empty",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "Ariadne subagent baseline snapshot",
      ]);

      return new SubAgentWorkspaceSession(
        workspaceRoot,
        repositoryRoot,
        new WriteScopeProcessSandbox(
          this.processSandbox,
          primaryReal,
          workspaceRoot,
          scopeId,
          repositoryRoot,
        ),
        lease,
      );
    } catch (error) {
      await lease.dispose();
      throw error;
    }
  }
}

function collectSnapshotPaths(trackedOutput: string, untrackedOutput: string): string[] {
  const tracked = parseNullPaths(trackedOutput);
  const untracked = parseNullPaths(untrackedOutput).filter((item) => !isRuntimePath(item));
  if (tracked.some(isRuntimePath)) {
    throw new Error("tracked_files_conflict_with_subagent_runtime_directory");
  }
  const paths = [...new Set([...tracked, ...untracked])];
  if (paths.length > MAX_SNAPSHOT_FILES) throw new Error("subagent_snapshot_file_limit_exceeded");
  return paths;
}

async function copySnapshot(
  repoRoot: string,
  repositoryRoot: string,
  relativePaths: readonly string[],
): Promise<void> {
  let totalBytes = 0;
  for (const relative of relativePaths) {
    const source = resolveDescendant(repoRoot, relative, "subagent_snapshot_source_path_escape");
    const target = resolveDescendant(repositoryRoot, relative, "subagent_snapshot_target_path_escape");
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`subagent_snapshot_link_rejected:${relative}`);
    if (!stat.isFile()) continue;
    if (stat.nlink > 1) throw new Error(`subagent_snapshot_hardlink_rejected:${relative}`);
    totalBytes += stat.size;
    if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error("subagent_snapshot_byte_limit_exceeded");
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

async function runGit(
  processSandbox: ProcessSandbox,
  cwd: string,
  workspaceRoot: string,
  args: string[],
  requestedMode?: Exclude<SandboxMode, "danger-full-access">,
): Promise<SandboxExecutionResult> {
  const mode = processSandbox.mode === "danger-full-access"
    ? "danger-full-access"
    : requestedMode;
  const result = await processSandbox.runFile({
    file: "git",
    args,
    cwd,
    workspaceRoot,
    mode,
    networkMode: "offline",
    timeoutMs: INTERNAL_TIMEOUT_MS,
    maxOutputBytes: INTERNAL_OUTPUT_BYTES,
  });
  assertProcessSuccess(result, `git ${args.join(" ")} failed`);
  return result;
}

function assertProcessSuccess(result: SandboxExecutionResult, message: string): void {
  if (result.spawnFailed || result.timedOut || result.exitCode !== 0 || result.truncated) {
    throw new Error(`${message}: ${result.stderr || `exitCode=${result.exitCode ?? "spawn_failed"}`}`);
  }
}

function parsePorcelainPaths(value: string): string[] {
  return [...new Set(value.split("\0").filter(Boolean).map((row) => row.slice(3).replace(/\\/g, "/")))]
    .filter(Boolean);
}

function parseNullPaths(value: string): string[] {
  return value.split("\0").filter(Boolean).map((item) => {
    if (item.includes("\0") || path.isAbsolute(item)) throw new Error("invalid_subagent_snapshot_path");
    const normalized = item.replace(/\\/g, "/");
    if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      throw new Error("invalid_subagent_snapshot_path");
    }
    return normalized;
  });
}

function isRuntimePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  return normalized === ".ariadne/runtime/subagent-workspaces"
    || normalized.startsWith(".ariadne/runtime/subagent-workspaces/");
}

function resolveDescendant(root: string, relative: string, code: string): string {
  const resolved = path.resolve(root, relative);
  const relation = path.relative(root, resolved);
  if (relation === "" || relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(code);
  return resolved;
}
