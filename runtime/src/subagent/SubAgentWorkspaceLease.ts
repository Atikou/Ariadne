import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import {
  lstat,
  link,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const SCOPE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const OWNER_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SCOPE_DIRECTORY_PATTERN = /^([0-9a-f]{32})-[a-zA-Z0-9_-]{1,40}$/u;
const TOMBSTONE_PATTERN = /^\.deleting-([0-9a-f]{32})-[0-9a-f]{16}$/u;
const LEASE_TEMPORARY_PATTERN = /^([0-9a-f]{32})\.json\.[0-9a-f]{16}\.tmp$/u;
const MAX_LEASE_BYTES = 16 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const RUNTIME_SEGMENTS = [".ariadne", "runtime", "subagent-workspaces"] as const;
const LEASES_DIRECTORY = "leases";

export const SubAgentWorkspaceLeaseMarkerSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("ariadne_subagent_workspace_lease"),
    scopeId: z.string().regex(SCOPE_ID_PATTERN),
    subAgentId: z.string().trim().min(1).max(512),
    ownerInstanceId: z.string().regex(OWNER_ID_PATTERN),
    ownerPid: z.number().int().positive(),
    primaryWorkspaceRoot: z.string().trim().min(1).max(32_768),
    scopeContainer: z.string().trim().min(1).max(32_768),
    repositoryRoot: z.string().trim().min(1).max(32_768),
    createdAt: z.string().datetime(),
    heartbeatAt: z.string().datetime(),
  })
  .strict()
  .superRefine((marker, ctx) => {
    if (Date.parse(marker.heartbeatAt) < Date.parse(marker.createdAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["heartbeatAt"],
        message: "heartbeatAt 不得早于 createdAt",
      });
    }
  });
export type SubAgentWorkspaceLeaseMarker = z.infer<typeof SubAgentWorkspaceLeaseMarkerSchema>;

export interface SubAgentWorkspaceRecoverySummary {
  recoveredScopes: number;
  preservedActiveScopes: number;
  quarantinedEntries: number;
}

export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface SubAgentWorkspaceLeaseStoreOptions {
  ownerInstanceId?: string;
  ownerPid?: number;
  heartbeatIntervalMs?: number;
  now?: () => Date;
  processLiveness?: (pid: number) => ProcessLiveness;
}

export interface SubAgentWorkspaceLeaseHandle {
  readonly marker: SubAgentWorkspaceLeaseMarker;
  dispose(): Promise<void>;
}

interface SubAgentScopePaths {
  runtimeRoot: string;
  leasesRoot: string;
  scopeContainer: string;
  repositoryRoot: string;
  leasePath: string;
}

export class SubAgentWorkspaceLeaseStore {
  private readonly ownerInstanceId: string;
  private readonly ownerPid: number;
  private readonly heartbeatIntervalMs: number;
  private readonly now: () => Date;
  private readonly processLiveness: (pid: number) => ProcessLiveness;

  constructor(options: SubAgentWorkspaceLeaseStoreOptions = {}) {
    this.ownerInstanceId = options.ownerInstanceId ?? randomBytes(16).toString("hex");
    this.ownerPid = options.ownerPid ?? process.pid;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.now = options.now ?? (() => new Date());
    this.processLiveness = options.processLiveness ?? defaultProcessLiveness;
    if (!OWNER_ID_PATTERN.test(this.ownerInstanceId)) throw new Error("invalid_subagent_lease_owner_id");
    if (!Number.isInteger(this.ownerPid) || this.ownerPid <= 0) throw new Error("invalid_subagent_lease_owner_pid");
    if (!Number.isInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 0) {
      throw new Error("invalid_subagent_lease_heartbeat_interval");
    }
  }

  async acquire(input: {
    primaryWorkspaceRoot: string;
    scopeId: string;
    subAgentId: string;
  }): Promise<SubAgentWorkspaceLeaseHandle> {
    if (!SCOPE_ID_PATTERN.test(input.scopeId)) throw new Error("invalid_subagent_scope_id");
    const primaryReal = await realpath(input.primaryWorkspaceRoot);
    const paths = resolveScopePaths(primaryReal, input.scopeId, input.subAgentId);
    await ensureRuntimeDirectories(primaryReal, paths);
    const createdAt = this.now().toISOString();
    const marker = SubAgentWorkspaceLeaseMarkerSchema.parse({
      version: 1,
      kind: "ariadne_subagent_workspace_lease",
      scopeId: input.scopeId,
      subAgentId: input.subAgentId,
      ownerInstanceId: this.ownerInstanceId,
      ownerPid: this.ownerPid,
      primaryWorkspaceRoot: primaryReal,
      scopeContainer: paths.scopeContainer,
      repositoryRoot: paths.repositoryRoot,
      createdAt,
      heartbeatAt: createdAt,
    });
    await publishInitialLease(paths.leasePath, marker);
    return new LeaseHandle(this, marker, paths, this.heartbeatIntervalMs, this.now);
  }

  recoverOrphanedScopes(primaryWorkspaceRoot: string): SubAgentWorkspaceRecoverySummary {
    const summary: SubAgentWorkspaceRecoverySummary = {
      recoveredScopes: 0,
      preservedActiveScopes: 0,
      quarantinedEntries: 0,
    };
    const primaryReal = realpathSync.native(primaryWorkspaceRoot);
    const runtimeRoot = path.join(primaryReal, ...RUNTIME_SEGMENTS);
    if (!existsSync(runtimeRoot)) return summary;
    assertRuntimeDirectoriesSync(primaryReal, runtimeRoot);
    const leasesRoot = path.join(runtimeRoot, LEASES_DIRECTORY);
    const validScopeIds = new Set<string>();

    if (existsSync(leasesRoot)) {
      assertManagedDirectorySync(primaryReal, leasesRoot);
      const leaseEntries = readdirSync(leasesRoot, { withFileTypes: true });
      const publishedLeaseIds = new Set(leaseEntries
        .filter((entry) => entry.isFile())
        .flatMap((entry) => entry.name.match(/^([0-9a-f]{32})\.json$/u)?.[1] ?? []));
      for (const entry of leaseEntries) {
        const leaseId = entry.name.match(/^([0-9a-f]{32})\.json$/u)?.[1];
        if (!entry.isFile() || !leaseId) {
          const temporaryLeaseId = entry.name.match(LEASE_TEMPORARY_PATTERN)?.[1];
          if (entry.isFile() && temporaryLeaseId && publishedLeaseIds.has(temporaryLeaseId)) continue;
          summary.quarantinedEntries += 1;
          continue;
        }
        const leasePath = path.join(leasesRoot, entry.name);
        let marker: SubAgentWorkspaceLeaseMarker;
        try {
          marker = readAndValidateLeaseSync(leasePath, primaryReal, leaseId);
        } catch {
          summary.quarantinedEntries += 1;
          continue;
        }
        validScopeIds.add(marker.scopeId);
        if (this.isOwnedByLiveProcess(marker)) {
          summary.preservedActiveScopes += 1;
          continue;
        }
        try {
          removeManagedScopeSync(marker);
          rmSync(leasePath, { force: true });
          summary.recoveredScopes += 1;
        } catch {
          summary.quarantinedEntries += 1;
        }
      }
    }

    for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
      const scopeId = entry.name.match(SCOPE_DIRECTORY_PATTERN)?.[1]
        ?? entry.name.match(TOMBSTONE_PATTERN)?.[1];
      if (scopeId && !validScopeIds.has(scopeId)) summary.quarantinedEntries += 1;
    }
    removeEmptyRuntimeDirectoriesSync(runtimeRoot);
    return summary;
  }

  async disposeLease(
    marker: SubAgentWorkspaceLeaseMarker,
    paths: SubAgentScopePaths,
  ): Promise<void> {
    validateLeaseIdentity(marker, paths.leasePath, marker.primaryWorkspaceRoot);
    await removeManagedScope(marker);
    await rm(paths.leasePath, { force: true });
    await removeEmptyRuntimeDirectories(paths.runtimeRoot);
  }

  private isOwnedByLiveProcess(marker: SubAgentWorkspaceLeaseMarker): boolean {
    if (marker.ownerPid === this.ownerPid) {
      return marker.ownerInstanceId === this.ownerInstanceId;
    }
    return this.processLiveness(marker.ownerPid) !== "dead";
  }
}

class LeaseHandle implements SubAgentWorkspaceLeaseHandle {
  private closed = false;
  private timer?: NodeJS.Timeout;
  private heartbeatWrite: Promise<void> = Promise.resolve();
  private currentMarker: SubAgentWorkspaceLeaseMarker;

  constructor(
    private readonly store: SubAgentWorkspaceLeaseStore,
    marker: SubAgentWorkspaceLeaseMarker,
    private readonly paths: SubAgentScopePaths,
    heartbeatIntervalMs: number,
    private readonly now: () => Date,
  ) {
    this.currentMarker = marker;
    if (heartbeatIntervalMs > 0) {
      this.timer = setInterval(() => this.queueHeartbeat(), heartbeatIntervalMs);
      this.timer.unref();
    }
  }

  get marker(): SubAgentWorkspaceLeaseMarker {
    return { ...this.currentMarker };
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.heartbeatWrite;
    await this.store.disposeLease(this.currentMarker, this.paths);
  }

  private queueHeartbeat(): void {
    this.heartbeatWrite = this.heartbeatWrite
      .then(async () => {
        if (this.closed) return;
        this.currentMarker = SubAgentWorkspaceLeaseMarkerSchema.parse({
          ...this.currentMarker,
          heartbeatAt: this.now().toISOString(),
        });
        await replaceLeaseAtomically(this.paths.leasePath, this.currentMarker);
      })
      .catch(() => {
        // A live PID remains authoritative; a failed heartbeat only makes cleanup conservative.
      });
  }
}

function resolveScopePaths(
  primaryWorkspaceRoot: string,
  scopeId: string,
  subAgentId: string,
): SubAgentScopePaths {
  const runtimeRoot = path.join(primaryWorkspaceRoot, ...RUNTIME_SEGMENTS);
  const leasesRoot = path.join(runtimeRoot, LEASES_DIRECTORY);
  const scopeContainer = path.join(runtimeRoot, `${scopeId}-${safeId(subAgentId)}`);
  return {
    runtimeRoot,
    leasesRoot,
    scopeContainer,
    repositoryRoot: path.join(scopeContainer, "repository"),
    leasePath: path.join(leasesRoot, `${scopeId}.json`),
  };
}

async function ensureRuntimeDirectories(
  primaryReal: string,
  paths: SubAgentScopePaths,
): Promise<void> {
  for (const candidate of runtimeDirectoryChain(primaryReal, paths.runtimeRoot, paths.leasesRoot)) {
    try {
      await mkdir(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertManagedDirectory(primaryReal, candidate);
  }
}

function assertRuntimeDirectoriesSync(primaryReal: string, runtimeRoot: string): void {
  const leasesRoot = path.join(runtimeRoot, LEASES_DIRECTORY);
  for (const candidate of runtimeDirectoryChain(primaryReal, runtimeRoot, leasesRoot).slice(0, -1)) {
    assertManagedDirectorySync(primaryReal, candidate);
  }
}

function runtimeDirectoryChain(primaryReal: string, runtimeRoot: string, leasesRoot: string): string[] {
  return [
    path.join(primaryReal, RUNTIME_SEGMENTS[0]),
    path.join(primaryReal, RUNTIME_SEGMENTS[0], RUNTIME_SEGMENTS[1]),
    runtimeRoot,
    leasesRoot,
  ];
}

async function assertManagedDirectory(primaryReal: string, candidate: string): Promise<void> {
  const stat = await lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("subagent_runtime_directory_invalid");
  const identity = await realpath(candidate);
  assertExpectedDirectoryIdentity(primaryReal, candidate, identity);
}

function assertManagedDirectorySync(primaryReal: string, candidate: string): void {
  const stat = lstatSync(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("subagent_runtime_directory_invalid");
  const identity = realpathSync.native(candidate);
  assertExpectedDirectoryIdentity(primaryReal, candidate, identity);
}

function assertExpectedDirectoryIdentity(primaryReal: string, candidate: string, identity: string): void {
  if (!samePath(identity, candidate) || !isDescendant(primaryReal, identity)) {
    throw new Error("subagent_runtime_path_identity_mismatch");
  }
}

function readAndValidateLeaseSync(
  leasePath: string,
  primaryReal: string,
  expectedScopeId: string,
): SubAgentWorkspaceLeaseMarker {
  const stat = lstatSync(leasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_LEASE_BYTES) {
    throw new Error("subagent_workspace_lease_file_invalid");
  }
  const marker = SubAgentWorkspaceLeaseMarkerSchema.parse(JSON.parse(readFileSync(leasePath, "utf8")));
  if (marker.scopeId !== expectedScopeId) throw new Error("subagent_workspace_lease_scope_mismatch");
  validateLeaseIdentity(marker, leasePath, primaryReal);
  return marker;
}

function validateLeaseIdentity(
  marker: SubAgentWorkspaceLeaseMarker,
  leasePath: string,
  primaryReal: string,
): void {
  const expected = resolveScopePaths(primaryReal, marker.scopeId, marker.subAgentId);
  if (!samePath(marker.primaryWorkspaceRoot, primaryReal) ||
      !samePath(marker.scopeContainer, expected.scopeContainer) ||
      !samePath(marker.repositoryRoot, expected.repositoryRoot) ||
      !samePath(leasePath, expected.leasePath)) {
    throw new Error("subagent_workspace_lease_path_mismatch");
  }
}

async function removeManagedScope(marker: SubAgentWorkspaceLeaseMarker): Promise<void> {
  const paths = resolveScopePaths(marker.primaryWorkspaceRoot, marker.scopeId, marker.subAgentId);
  await moveAndRemoveScope(paths.runtimeRoot, paths.scopeContainer, marker.scopeId);
  await removeTombstones(paths.runtimeRoot, marker.scopeId);
}

function removeManagedScopeSync(marker: SubAgentWorkspaceLeaseMarker): void {
  const paths = resolveScopePaths(marker.primaryWorkspaceRoot, marker.scopeId, marker.subAgentId);
  moveAndRemoveScopeSync(paths.runtimeRoot, paths.scopeContainer, marker.scopeId);
  removeTombstonesSync(paths.runtimeRoot, marker.scopeId);
}

async function moveAndRemoveScope(runtimeRoot: string, scopeContainer: string, scopeId: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(scopeContainer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("subagent_scope_identity_invalid");
  await assertScopeIdentity(runtimeRoot, scopeContainer);
  const tombstone = path.join(runtimeRoot, `.deleting-${scopeId}-${randomBytes(8).toString("hex")}`);
  await rename(scopeContainer, tombstone);
  await removeEntryNoFollow(tombstone);
}

function moveAndRemoveScopeSync(runtimeRoot: string, scopeContainer: string, scopeId: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(scopeContainer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("subagent_scope_identity_invalid");
  assertScopeIdentitySync(runtimeRoot, scopeContainer);
  const tombstone = path.join(runtimeRoot, `.deleting-${scopeId}-${randomBytes(8).toString("hex")}`);
  renameSync(scopeContainer, tombstone);
  removeEntryNoFollowSync(tombstone);
}

async function assertScopeIdentity(runtimeRoot: string, scopeContainer: string): Promise<void> {
  const runtimeIdentity = await realpath(runtimeRoot);
  const scopeIdentity = await realpath(scopeContainer);
  const expected = path.join(runtimeIdentity, path.basename(scopeContainer));
  if (!samePath(scopeIdentity, expected)) throw new Error("subagent_scope_path_identity_mismatch");
}

function assertScopeIdentitySync(runtimeRoot: string, scopeContainer: string): void {
  const runtimeIdentity = realpathSync.native(runtimeRoot);
  const scopeIdentity = realpathSync.native(scopeContainer);
  const expected = path.join(runtimeIdentity, path.basename(scopeContainer));
  if (!samePath(scopeIdentity, expected)) throw new Error("subagent_scope_path_identity_mismatch");
}

async function removeTombstones(runtimeRoot: string, scopeId: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(runtimeRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of entries) {
    if (name.match(TOMBSTONE_PATTERN)?.[1] === scopeId) {
      await removeEntryNoFollow(path.join(runtimeRoot, name));
    }
  }
}

function removeTombstonesSync(runtimeRoot: string, scopeId: string): void {
  if (!existsSync(runtimeRoot)) return;
  for (const name of readdirSync(runtimeRoot)) {
    if (name.match(TOMBSTONE_PATTERN)?.[1] === scopeId) {
      removeEntryNoFollowSync(path.join(runtimeRoot, name));
    }
  }
}

async function removeEntryNoFollow(target: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await rm(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
}

function removeEntryNoFollowSync(target: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  rmSync(target, { recursive: stat.isDirectory() && !stat.isSymbolicLink(), force: true });
}

async function removeEmptyRuntimeDirectories(runtimeRoot: string): Promise<void> {
  for (const candidate of [
    path.join(runtimeRoot, LEASES_DIRECTORY),
    runtimeRoot,
    path.dirname(runtimeRoot),
    path.dirname(path.dirname(runtimeRoot)),
  ]) {
    try {
      await rmdir(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") return;
    }
  }
}

function removeEmptyRuntimeDirectoriesSync(runtimeRoot: string): void {
  for (const candidate of [
    path.join(runtimeRoot, LEASES_DIRECTORY),
    runtimeRoot,
    path.dirname(runtimeRoot),
    path.dirname(path.dirname(runtimeRoot)),
  ]) {
    try {
      rmdirSync(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") return;
    }
  }
}

function defaultProcessLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

function serializeLease(marker: SubAgentWorkspaceLeaseMarker): string {
  return `${JSON.stringify(SubAgentWorkspaceLeaseMarkerSchema.parse(marker))}\n`;
}

async function publishInitialLease(
  leasePath: string,
  marker: SubAgentWorkspaceLeaseMarker,
): Promise<void> {
  const temporaryPath = leaseTemporaryPath(leasePath);
  try {
    await writeFile(temporaryPath, serializeLease(marker), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await link(temporaryPath, leasePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function replaceLeaseAtomically(
  leasePath: string,
  marker: SubAgentWorkspaceLeaseMarker,
): Promise<void> {
  const temporaryPath = leaseTemporaryPath(leasePath);
  try {
    await writeFile(temporaryPath, serializeLease(marker), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, leasePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function leaseTemporaryPath(leasePath: string): string {
  return `${leasePath}.${randomBytes(8).toString("hex")}.tmp`;
}

function isDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40) || "run";
}
