import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ToolPermission } from "../core/permissions.js";
import type { HookConfig } from "../config/types.js";

export const HOOK_EVENTS = [
  "session.pre",
  "session.post",
  "run.pre",
  "run.post",
  "model.pre",
  "model.post",
  "tool.pre",
  "tool.post",
  "subagent.pre",
  "subagent.post",
  "stop",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];
export type HookFailurePolicy = "fail-open" | "fail-closed";

export interface HookConstraints {
  permissions?: ToolPermission[];
  timeoutMs?: number;
}

export interface HookDecision {
  decision: "allow" | "reject";
  reason?: string;
  constraints?: HookConstraints;
}

export interface HookDeliveryInput {
  event: HookEvent;
  eventId: string;
  payload: Record<string, unknown>;
  authority: {
    permissions: ToolPermission[];
    timeoutMs: number;
  };
}

export interface HookDefinition {
  id: string;
  version: string;
  events: readonly HookEvent[];
  timeoutMs: number;
  failurePolicy: HookFailurePolicy;
  handler(input: HookDeliveryInput & { deliveryId: string }): Promise<HookDecision>;
}

export interface HookDispatchResult {
  allowed: boolean;
  reason?: string;
  authority: HookDeliveryInput["authority"];
  deliveryIds: string[];
}

/** Durable, at-least-once hook dispatcher. Hooks may reject or narrow authority, never expand it. */
export class HookManager {
  private readonly hooks = new Map<string, HookDefinition>();

  constructor(private readonly db: DatabaseSync) {}

  register(hook: HookDefinition): void {
    if (!/^[a-z][a-z0-9_-]*$/u.test(hook.id)) throw new Error("hook_invalid_id");
    if (!hook.version.trim()) throw new Error("hook_invalid_version");
    if (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs <= 0) {
      throw new Error("hook_invalid_timeout");
    }
    if (this.hooks.has(hook.id)) throw new Error(`hook_duplicate:${hook.id}`);
    this.hooks.set(hook.id, hook);
  }

  registerConfigured(config: HookConfig): void {
    for (const definition of config.definitions) {
      this.register({
        id: definition.id,
        version: definition.version,
        events: definition.events,
        timeoutMs: definition.timeoutMs,
        failurePolicy: definition.failurePolicy,
        handler: async () => ({
          decision: definition.decision,
          reason: definition.reason,
          constraints: definition.constraints,
        }),
      });
    }
  }

  async dispatch(input: HookDeliveryInput): Promise<HookDispatchResult> {
    let authority = {
      permissions: [...input.authority.permissions],
      timeoutMs: input.authority.timeoutMs,
    };
    const deliveryIds: string[] = [];

    for (const hook of this.hooks.values()) {
      if (!hook.events.includes(input.event)) continue;
      const deliveryId = stableDeliveryId(hook, input);
      deliveryIds.push(deliveryId);
      const decision = await this.deliver(hook, input, deliveryId);
      if (decision.decision === "reject") {
        return {
          allowed: false,
          reason: decision.reason ?? `hook_rejected:${hook.id}`,
          authority,
          deliveryIds,
        };
      }
      authority = narrowAuthority(authority, decision.constraints);
    }

    return { allowed: true, authority, deliveryIds };
  }

  private async deliver(
    hook: HookDefinition,
    input: HookDeliveryInput,
    deliveryId: string,
  ): Promise<HookDecision> {
    const prior = this.db.prepare(
      `SELECT status, result_json, error FROM hook_deliveries WHERE delivery_id=?`,
    ).get(deliveryId) as {
      status: "delivering" | "delivered" | "failed";
      result_json: string | null;
      error: string | null;
    } | undefined;
    if (prior?.status === "delivered" && prior.result_json) {
      return JSON.parse(prior.result_json) as HookDecision;
    }
    if (prior?.status === "failed") return failureDecision(hook, prior.error ?? "hook_failed");

    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO hook_deliveries (
         delivery_id, hook_id, hook_version, event, event_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'delivering', ?, ?)
       ON CONFLICT(delivery_id) DO UPDATE SET status='delivering', updated_at=excluded.updated_at`,
    ).run(deliveryId, hook.id, hook.version, input.event, input.eventId, now, now);

    try {
      const raw = await withTimeout(
        hook.handler({ ...input, deliveryId }),
        hook.timeoutMs,
      );
      const decision = validateDecision(raw, input.authority);
      this.db.prepare(
        `UPDATE hook_deliveries
         SET status='delivered', result_json=?, error=NULL, updated_at=?
         WHERE delivery_id=?`,
      ).run(JSON.stringify(decision), new Date().toISOString(), deliveryId);
      return decision;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare(
        `UPDATE hook_deliveries
         SET status='failed', error=?, updated_at=?
         WHERE delivery_id=?`,
      ).run(message, new Date().toISOString(), deliveryId);
      return failureDecision(hook, message);
    }
  }
}

function stableDeliveryId(hook: HookDefinition, input: HookDeliveryInput): string {
  return createHash("sha256")
    .update(`${hook.id}\0${hook.version}\0${input.event}\0${input.eventId}`)
    .digest("hex");
}

function validateDecision(
  decision: HookDecision,
  current: HookDeliveryInput["authority"],
): HookDecision {
  if (decision.decision !== "allow" && decision.decision !== "reject") {
    throw new Error("hook_invalid_decision");
  }
  narrowAuthority(current, decision.constraints);
  return decision;
}

function narrowAuthority(
  current: HookDeliveryInput["authority"],
  constraints?: HookConstraints,
): HookDeliveryInput["authority"] {
  const permissions = constraints?.permissions ?? current.permissions;
  if (permissions.some((permission) => !current.permissions.includes(permission))) {
    throw new Error("hook_authority_expansion_denied");
  }
  const timeoutMs = constraints?.timeoutMs ?? current.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > current.timeoutMs) {
    throw new Error("hook_timeout_expansion_denied");
  }
  return { permissions: [...new Set(permissions)], timeoutMs };
}

function failureDecision(hook: HookDefinition, error: string): HookDecision {
  return hook.failurePolicy === "fail-open"
    ? { decision: "allow", reason: `hook_failed_open:${hook.id}:${error}` }
    : { decision: "reject", reason: `hook_failed_closed:${hook.id}:${error}` };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("hook_timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
