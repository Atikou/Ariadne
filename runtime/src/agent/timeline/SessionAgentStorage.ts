import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const SESSION_STORAGE_DIRECTORY = "sessions";

export function sessionAgentStorageRoot(dataRoot: string, sessionId: string): string {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) throw new Error("session_agent_storage_id_required");
  const identity = createHash("sha256")
    .update(normalizedSessionId)
    .digest("hex")
    .slice(0, 32);
  return path.join(path.resolve(dataRoot), SESSION_STORAGE_DIRECTORY, `session-${identity}`);
}

export function listSessionAgentStorageRoots(dataRoot: string): string[] {
  const sessionsRoot = path.join(path.resolve(dataRoot), SESSION_STORAGE_DIRECTORY);
  if (!existsSync(sessionsRoot)) return [];
  return readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^session-[a-f0-9]{32}$/u.test(entry.name))
    .map((entry) => path.join(sessionsRoot, entry.name));
}

export function deleteSessionAgentStorage(dataRoot: string, sessionId: string): boolean {
  const sessionsRoot = path.join(path.resolve(dataRoot), SESSION_STORAGE_DIRECTORY);
  const target = sessionAgentStorageRoot(dataRoot, sessionId);
  if (path.dirname(target) !== sessionsRoot) {
    throw new Error("session_agent_storage_path_escape");
  }
  if (!existsSync(target)) return false;
  rmSync(target, { recursive: true, force: true });
  return true;
}
