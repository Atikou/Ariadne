import type { DatabaseSync } from "node:sqlite";

import type { PausedRunStore } from "../agent/PausedRunStore.js";
import type { RunStatus } from "../core/runTypes.js";
import type { PlanHandoffStore } from "../policy/PlanHandoffStore.js";
import type {
  PlanHandoffPayload,
  PlanHandoffRespondInput,
} from "../policy/planHandoffTypes.js";
import type { RunStore } from "./RunStore.js";

export class PlanHandoffDecisionConsistencyError extends Error {
  readonly code = "PLAN_HANDOFF_STATE_INCONSISTENT";

  constructor(message: string) {
    super(message);
    this.name = "PlanHandoffDecisionConsistencyError";
  }
}

export class PlanHandoffDecisionService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly handoffs: PlanHandoffStore,
    private readonly runs: Pick<RunStore, "get" | "update">,
    private readonly pausedRuns: Pick<PausedRunStore, "delete">,
  ) {}

  respond(id: string, input: PlanHandoffRespondInput): PlanHandoffPayload | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.handoffs.get(id);
      if (!current || current.status !== "pending") {
        this.db.exec("COMMIT");
        return null;
      }

      const run = this.runs.get(current.runId);
      if (!run && !isEphemeralRunId(current.runId)) {
        throw new PlanHandoffDecisionConsistencyError(
          `计划交接 ${current.id} 引用的 Run 不存在`,
        );
      }
      if (run && run.kind !== "agent") {
        throw new PlanHandoffDecisionConsistencyError(
          `计划交接 ${current.id} 引用了非 Agent Run`,
        );
      }
      if (run && run.status !== "waiting_plan_handoff") {
        throw new PlanHandoffDecisionConsistencyError(
          `计划交接 ${current.id} 引用的 Run 状态不是 waiting_plan_handoff`,
        );
      }
      if (run && run.sessionId !== current.sessionId) {
        throw new PlanHandoffDecisionConsistencyError(
          `计划交接 ${current.id} 与关联 Run 的 sessionId 不一致`,
        );
      }

      const responded = this.handoffs.respond(id, input);
      if (!responded) {
        throw new PlanHandoffDecisionConsistencyError(
          `计划交接 ${current.id} 在决定事务中丢失 pending 状态`,
        );
      }

      if (run) {
        const status: RunStatus = input.decision === "reject"
          ? "cancelled"
          : "waiting_plan_handoff";
        if (!this.runs.update(run.id, { status })) {
          throw new PlanHandoffDecisionConsistencyError(
            `计划交接 ${current.id} 无法更新关联 Run`,
          );
        }
      }
      if (input.decision === "reject") this.pausedRuns.delete(current.runId);

      this.db.exec("COMMIT");
      return responded;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "计划交接决定失败，且 SQLite 回滚失败",
        );
      }
      throw error;
    }
  }
}

function isEphemeralRunId(runId: string): boolean {
  return runId.startsWith("ephemeral:");
}
