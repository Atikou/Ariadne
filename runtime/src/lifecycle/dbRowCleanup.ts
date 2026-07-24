import type { DatabaseManager } from "../context/DatabaseManager.js";
import { fileAgeDays } from "./fsUtils.js";
import type { LifecyclePolicy } from "./types.js";

export type DbRowCleanupKind = "soft_deleted_memories" | "stale_routing_logs";

const ROW_BYTES_ESTIMATE = 384;

function cutoffIso(now: number, retentionDays: number): string {
  return new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

export function countSoftDeletedMemories(
  memoryDb: DatabaseManager,
  policy: LifecyclePolicy,
  now = Date.now(),
): number {
  const cutoff = cutoffIso(now, policy.retentionDays.softDeletedRows);
  const row = memoryDb.connection
    .prepare(`SELECT COUNT(*) AS c FROM memories WHERE is_active=0 AND updated_at < ?`)
    .get(cutoff) as { c: number };
  return Number(row.c);
}

export function purgeSoftDeletedMemories(
  memoryDb: DatabaseManager,
  policy: LifecyclePolicy,
  now = Date.now(),
): number {
  const cutoff = cutoffIso(now, policy.retentionDays.softDeletedRows);
  const result = memoryDb.connection
    .prepare(`DELETE FROM memories WHERE is_active=0 AND updated_at < ?`)
    .run(cutoff);
  return Number(result.changes);
}

export function countStaleRoutingRows(
  memoryDb: DatabaseManager,
  policy: LifecyclePolicy,
  now = Date.now(),
): number {
  const cutoff = cutoffIso(now, policy.retentionDays.routeDetails);
  const conn = memoryDb.connection;
  const calls = Number(
    (conn.prepare(`SELECT COUNT(*) AS c FROM model_call_logs WHERE created_at < ?`).get(cutoff) as { c: number }).c,
  );
  const fallbacks = Number(
    (conn.prepare(`SELECT COUNT(*) AS c FROM fallback_logs WHERE created_at < ?`).get(cutoff) as { c: number }).c,
  );
  const routes = Number(
    (conn.prepare(`SELECT COUNT(*) AS c FROM model_route_logs WHERE created_at < ?`).get(cutoff) as { c: number }).c,
  );
  return calls + fallbacks + routes;
}

export function purgeStaleRoutingRows(
  memoryDb: DatabaseManager,
  policy: LifecyclePolicy,
  now = Date.now(),
): number {
  const cutoff = cutoffIso(now, policy.retentionDays.routeDetails);
  const conn = memoryDb.connection;
  const callRes = conn.prepare(`DELETE FROM model_call_logs WHERE created_at < ?`).run(cutoff);
  const fbRes = conn.prepare(`DELETE FROM fallback_logs WHERE created_at < ?`).run(cutoff);
  const collabRes = conn
    .prepare(
      `DELETE FROM model_collaboration_runs WHERE created_at < ? AND status IN ('completed', 'failed', 'cancelled')`,
    )
    .run(cutoff);
  const routeRes = conn.prepare(`DELETE FROM model_route_logs WHERE created_at < ?`).run(cutoff);
  return (
    Number(callRes.changes) +
    Number(fbRes.changes) +
    Number(collabRes.changes) +
    Number(routeRes.changes)
  );
}

export function estimateDbRowBytes(rowCount: number): number {
  return rowCount * ROW_BYTES_ESTIMATE;
}

export function parseDbRowCleanupKind(path: string): DbRowCleanupKind | undefined {
  if (path === "db:memory:soft_deleted_memories") return "soft_deleted_memories";
  if (path === "db:memory:stale_routing_logs") return "stale_routing_logs";
  return undefined;
}

export function eventAgeDaysFromIso(time: string | undefined, now: number): number | undefined {
  if (!time) return undefined;
  const ms = Date.parse(time);
  if (Number.isNaN(ms)) return undefined;
  return fileAgeDays(ms, now);
}

export function isFailedTraceEvent(event: Record<string, unknown>): boolean {
  const status = event.status;
  if (status === "error" || status === "failed" || status === "timeout") return true;
  if (event.type === "tool_audit" && status === "error") return true;
  return false;
}
