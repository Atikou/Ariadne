import { createHash } from "node:crypto";
import path from "node:path";

export function deriveWriteScopeCapabilitySid(scopeId: string, scopeRoot: string): string {
  if (!/^[0-9a-f]{32}$/u.test(scopeId)) throw new Error("invalid_write_scope_id");
  const canonicalRoot = path.resolve(scopeRoot).replace(/\//g, "\\").toUpperCase();
  const digest = createHash("sha256")
    .update(scopeId, "utf8")
    .update("\0", "utf8")
    .update(canonicalRoot, "utf8")
    .digest();
  return `S-1-5-21-${digest.readUInt32LE(0)}-${digest.readUInt32LE(4)}-${digest.readUInt32LE(8)}-${digest.readUInt32LE(12)}`;
}

export function writeScopeCapabilitySidHash(scopeId: string, scopeRoot: string): string {
  return createHash("sha256")
    .update(deriveWriteScopeCapabilitySid(scopeId, scopeRoot), "utf8")
    .digest("hex");
}
