import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import { canonicalizePathIdentity } from "../../platform/pathIdentity.js";

const WORKSPACE_STORAGE_DIRECTORY = "workspaces";
const SESSION_STORAGE_DIRECTORY = "sessions";
const WORKSPACE_ID_HASH_LENGTH = 16;
const SESSION_ID_HASH_LENGTH = 32;

/**
 * Returns the application-owned folder for one workspace.
 *
 * The readable prefix helps local inspection while the path digest keeps
 * same-named workspaces separate and stable across catalog renames.
 */
export function workspaceStorageRoot(dataRoot: string, workspaceRoot: string): string {
  const identity = workspacePathIdentity(workspaceRoot);
  const label = safeDirectoryLabel(path.basename(identity));
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, WORKSPACE_ID_HASH_LENGTH);
  return path.join(
    path.resolve(dataRoot),
    WORKSPACE_STORAGE_DIRECTORY,
    `${label}-${digest}`,
  );
}

/** Application-owned session folder grouped beneath its workspace. */
export function workspaceSessionStorageRoot(
  dataRoot: string,
  workspaceRoot: string,
  sessionId: string,
): string {
  return path.join(
    workspaceStorageRoot(dataRoot, workspaceRoot),
    SESSION_STORAGE_DIRECTORY,
    sessionDirectoryName(sessionId),
  );
}

/** Lists every session artifact root across all configured workspace folders. */
export function listWorkspaceSessionStorageRoots(dataRoot: string): string[] {
  const workspacesRoot = path.join(path.resolve(dataRoot), WORKSPACE_STORAGE_DIRECTORY);
  if (!existsSync(workspacesRoot)) return [];
  const roots: string[] = [];
  for (const workspaceEntry of readdirSync(workspacesRoot, { withFileTypes: true })) {
    if (!workspaceEntry.isDirectory()) continue;
    const sessionsRoot = path.join(workspacesRoot, workspaceEntry.name, SESSION_STORAGE_DIRECTORY);
    if (!existsSync(sessionsRoot)) continue;
    for (const sessionEntry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory() || !/^session-[a-f0-9]{32}$/u.test(sessionEntry.name)) continue;
      roots.push(path.join(sessionsRoot, sessionEntry.name));
    }
  }
  return roots;
}

/** Finds a globally unique session without requiring its workspace to still be registered. */
export function findWorkspaceSessionStorageRoots(dataRoot: string, sessionId: string): string[] {
  const expectedName = sessionDirectoryName(sessionId);
  return listWorkspaceSessionStorageRoots(dataRoot)
    .filter((root) => path.basename(root) === expectedName);
}

/** Deletes all application-owned artifact folders for one session. */
export function deleteWorkspaceSessionStorage(dataRoot: string, sessionId: string): boolean {
  const targets = findWorkspaceSessionStorageRoots(dataRoot, sessionId);
  for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
    pruneEmptyWorkspaceStorageAncestors(target);
  }
  return targets.length > 0;
}

/** Removes empty run/session/workspace ancestors after the last artifact is deleted. */
export function pruneEmptyWorkspaceSessionStorage(sessionStorageRoot: string): void {
  removeDirectoryIfEmpty(path.join(sessionStorageRoot, "runs"));
  pruneEmptyWorkspaceStorageAncestors(sessionStorageRoot);
}

function sessionDirectoryName(sessionId: string): string {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) throw new Error("workspace_session_storage_id_required");
  const identity = createHash("sha256")
    .update(normalizedSessionId)
    .digest("hex")
    .slice(0, SESSION_ID_HASH_LENGTH);
  return `session-${identity}`;
}

function workspacePathIdentity(workspaceRoot: string): string {
  const canonical = canonicalizePathIdentity(workspaceRoot);
  return process.platform === "win32"
    ? canonical.toLocaleLowerCase("en-US")
    : canonical;
}

function safeDirectoryLabel(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 48);
  return sanitized || "workspace";
}

function pruneEmptyWorkspaceStorageAncestors(sessionStorageRoot: string): void {
  const sessionsRoot = path.dirname(sessionStorageRoot);
  const workspaceRoot = path.dirname(sessionsRoot);
  const workspacesRoot = path.dirname(workspaceRoot);
  if (
    path.basename(sessionsRoot) !== SESSION_STORAGE_DIRECTORY
    || path.basename(workspacesRoot) !== WORKSPACE_STORAGE_DIRECTORY
  ) return;
  removeDirectoryIfEmpty(sessionStorageRoot);
  removeDirectoryIfEmpty(sessionsRoot);
  removeDirectoryIfEmpty(workspaceRoot);
  removeDirectoryIfEmpty(workspacesRoot);
}

function removeDirectoryIfEmpty(target: string): boolean {
  if (!existsSync(target) || readdirSync(target).length > 0) return false;
  rmdirSync(target);
  return true;
}
