import { createHash } from "node:crypto";

import type { ToolRunResult } from "../tools/types.js";
import type { RunAggregateRepository } from "./RunAggregateRepository.js";

export interface ToolCheckpointIntentInput {
  toolCallId: string;
  toolName: string;
  toolVersion: string;
  input: Record<string, unknown>;
  effects: readonly string[];
  resumable: boolean;
}

export interface ToolCheckpointToken {
  idempotencyKey: string;
  runId: string;
}

export type ToolCheckpointIntent =
  | { kind: "execute"; token: ToolCheckpointToken }
  | { kind: "replay"; result: ToolRunResult };

/** 将工具 intent/start/result 严格写入所属 Run 的事务日志。 */
export class RunToolCheckpointCoordinator {
  constructor(
    private readonly runs: RunAggregateRepository,
    private readonly runId: string,
  ) {}

  intend(input: ToolCheckpointIntentInput): ToolCheckpointIntent {
    const aggregate = this.requireRunning();
    const inputHash = hashCanonicalJson(input.input);
    const idempotencyKey = `${this.runId}:${input.toolCallId}:${input.toolVersion}:${inputHash}`;
    const existing = this.runs.getToolLedgerEntry(idempotencyKey);
    if (existing) {
      if (
        existing.runId !== this.runId
        || existing.toolName !== input.toolName
        || existing.toolVersion !== input.toolVersion
        || existing.inputHash !== inputHash
      ) {
        throw new Error(`tool_idempotency_conflict:${idempotencyKey}`);
      }
      if (existing.status === "succeeded" || existing.status === "failed") {
        const succeeded = existing.status === "succeeded";
        return {
          kind: "replay",
          result: {
            tool: input.toolName,
            toolCallId: input.toolCallId,
            durationMs: 0,
            executed: true,
            outcomeClass: succeeded ? "observation_success" : "execution_error",
            outcomeKind: succeeded ? "idempotent_replay" : "idempotent_replay_failed",
            message: succeeded
              ? "已复用该工具调用的持久化成功结果"
              : "该工具调用此前已执行失败，已复用持久化失败结果",
            recoverable: !succeeded,
            output: existing.output,
            ok: succeeded,
            ...(succeeded ? {} : { error: "工具调用此前已执行失败" }),
          },
        };
      }
      if (existing.status === "intended") {
        return {
          kind: "execute",
          token: { idempotencyKey, runId: this.runId },
        };
      }
      if (existing.status === "started" && input.resumable) {
        const current = this.runs.get(this.runId);
        if (!current) throw new Error(`run_not_found:${this.runId}`);
        this.runs.execute({
          type: "run.tool_retry",
          runId: this.runId,
          expectedAggregateVersion: current.aggregateVersion,
          idempotencyKey,
          causationId: input.toolCallId,
        });
        return {
          kind: "execute",
          token: { idempotencyKey, runId: this.runId },
        };
      }
      throw new Error(`tool_checkpoint_recovery_required:${idempotencyKey}:${existing.status}`);
    }
    this.runs.execute({
      type: "run.tool_intent",
      runId: this.runId,
      expectedAggregateVersion: aggregate.aggregateVersion,
      idempotencyKey,
      toolName: input.toolName,
      toolVersion: input.toolVersion,
      inputHash,
      effects: [...input.effects],
      resumable: input.resumable,
      causationId: input.toolCallId,
    });
    return {
      kind: "execute",
      token: { idempotencyKey, runId: this.runId },
    };
  }

  start(token: ToolCheckpointToken): void {
    const aggregate = this.requireRunning();
    this.runs.execute({
      type: "run.tool_start",
      runId: this.runId,
      expectedAggregateVersion: aggregate.aggregateVersion,
      idempotencyKey: token.idempotencyKey,
    });
  }

  finish(token: ToolCheckpointToken, result: ToolRunResult): void {
    const aggregate = this.requireRunning();
    this.runs.execute({
      type: "run.tool_result",
      runId: this.runId,
      expectedAggregateVersion: aggregate.aggregateVersion,
      idempotencyKey: token.idempotencyKey,
      status: result.code === "timeout"
        ? "cancelled"
        : result.ok
          ? "succeeded"
          : "failed",
      output: result.output ?? {
        code: result.code,
        category: result.category,
        outcomeClass: result.outcomeClass,
        outcomeKind: result.outcomeKind,
        message: result.message,
      },
      verification: {
        kind: "tool_contract_output",
        passed: result.code !== "invalid_output",
      },
    });
  }

  private requireRunning() {
    const aggregate = this.runs.get(this.runId);
    if (!aggregate) throw new Error(`run_not_found:${this.runId}`);
    if (aggregate.status !== "running") {
      throw new Error(`run_not_executable:${this.runId}:${aggregate.status}`);
    }
    return aggregate;
  }
}

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
