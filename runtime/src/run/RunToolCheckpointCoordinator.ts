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

/** 将工具 intent/start/result 严格写入所属 Run 的事务日志。 */
export class RunToolCheckpointCoordinator {
  constructor(
    private readonly runs: RunAggregateRepository,
    private readonly runId: string,
  ) {}

  intend(input: ToolCheckpointIntentInput): ToolCheckpointToken {
    const aggregate = this.requireRunning();
    const inputHash = hashCanonicalJson(input.input);
    const idempotencyKey = `${this.runId}:${input.toolCallId}:${input.toolVersion}:${inputHash}`;
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
    return { idempotencyKey, runId: this.runId };
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
