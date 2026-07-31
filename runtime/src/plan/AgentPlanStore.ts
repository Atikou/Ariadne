import type { DatabaseSync } from "node:sqlite";

import {
  AgentPlanContractSchema,
  createAgentPlanContract,
  evaluateAgentPlanExecutionReport,
  evaluateAgentPlanDraft,
  type AgentPlanContract,
  type AgentPlanExecutionReport,
  type AgentPlanModelDraft,
} from "./AgentPlanContract.js";

interface AgentPlanRow {
  plan_id: string;
  version: number;
  session_id: string | null;
  run_id: string;
  plan_state: string;
  execution_state: string;
  payload_json: string;
}

export class AgentPlanQualityError extends Error {
  readonly code = "AGENT_PLAN_QUALITY_INVALID";

  constructor(readonly messages: string[]) {
    super(messages.join("; "));
    this.name = "AgentPlanQualityError";
  }
}

export class AgentPlanVersionError extends Error {
  readonly code = "AGENT_PLAN_VERSION_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "AgentPlanVersionError";
  }
}

export class AgentPlanStore {
  private readonly plans = new Map<string, AgentPlanContract>();

  constructor(private readonly db?: DatabaseSync) {}

  transactionalCreateFromModel<T>(
    input: {
      draft: AgentPlanModelDraft;
      runId: string;
      sessionId?: string;
    },
    afterCreate: (plan: AgentPlanContract) => T,
  ): T {
    if (this.db) {
      const ownsTransaction = !this.db.isTransaction;
      if (ownsTransaction) this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = afterCreate(this.createFromModel(input));
        if (ownsTransaction) this.db.exec("COMMIT");
        return result;
      } catch (error) {
        if (ownsTransaction && this.db.isTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
    }

    const before = new Map(
      [...this.plans.entries()].map(([id, plan]) => [id, clone(plan)!]),
    );
    try {
      return afterCreate(this.createFromModel(input));
    } catch (error) {
      this.plans.clear();
      for (const [id, plan] of before) this.plans.set(id, plan);
      throw error;
    }
  }

  createFromModel(input: {
    draft: AgentPlanModelDraft;
    runId: string;
    sessionId?: string;
  }): AgentPlanContract {
    const evaluation = evaluateAgentPlanDraft(input.draft);
    if (!evaluation.draft || !evaluation.acceptable) {
      throw new AgentPlanQualityError(evaluation.issues.map((issue) => issue.message));
    }

    const base = input.draft.basePlanId
      ? this.get(input.draft.basePlanId, input.draft.baseVersion)
      : undefined;
    if (input.draft.basePlanId && !base) {
      throw new AgentPlanVersionError(
        `基础计划 ${input.draft.basePlanId} v${input.draft.baseVersion} 不存在。`,
      );
    }
    if (base) {
      const latest = this.get(base.planId);
      if (!latest || latest.version !== base.version || latest.planState === "superseded") {
        throw new AgentPlanVersionError(
          `基础计划 ${base.planId} v${base.version} 已不是最新版本。`,
        );
      }
      this.save({
        ...base,
        planState: "superseded",
        updatedAt: new Date().toISOString(),
      });
    }

    const plan = createAgentPlanContract({
      draft: evaluation.draft,
      issues: evaluation.issues,
      runId: input.runId,
      sessionId: input.sessionId,
      planId: base?.planId,
      version: base ? base.version + 1 : 1,
      supersedesVersion: base?.version,
    });
    return this.save(plan);
  }

  get(planId: string, version?: number): AgentPlanContract | null {
    if (this.db) {
      const row = version === undefined
        ? this.db.prepare(
            `SELECT plan_id, version, session_id, run_id, plan_state, execution_state, payload_json
             FROM agent_plan_contracts WHERE plan_id=? ORDER BY version DESC LIMIT 1`,
          ).get(planId) as AgentPlanRow | undefined
        : this.db.prepare(
            `SELECT plan_id, version, session_id, run_id, plan_state, execution_state, payload_json
             FROM agent_plan_contracts WHERE plan_id=? AND version=?`,
          ).get(planId, version) as AgentPlanRow | undefined;
      return parseRow(row);
    }
    if (version !== undefined) return clone(this.plans.get(key(planId, version)) ?? null);
    const candidates = [...this.plans.values()]
      .filter((plan) => plan.planId === planId)
      .sort((left, right) => right.version - left.version);
    return clone(candidates[0] ?? null);
  }

  getLatestForSession(sessionId: string): AgentPlanContract | null {
    if (this.db) {
      const row = this.db.prepare(
        `SELECT plan_id, version, session_id, run_id, plan_state, execution_state, payload_json
         FROM agent_plan_contracts
         WHERE session_id=?
         ORDER BY created_at DESC, version DESC
         LIMIT 1`,
      ).get(sessionId) as AgentPlanRow | undefined;
      return parseRow(row);
    }
    const candidates = [...this.plans.values()]
      .filter((plan) => plan.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
        || right.version - left.version);
    return clone(candidates[0] ?? null);
  }

  markApproved(planId: string, version: number): AgentPlanContract {
    const plan = this.require(planId, version);
    if (plan.planState !== "ready_for_confirmation") {
      throw new AgentPlanVersionError(
        `计划 ${planId} v${version} 当前状态 ${plan.planState} 不允许批准。`,
      );
    }
    return this.save({
      ...plan,
      planState: "approved",
      updatedAt: new Date().toISOString(),
    });
  }

  markSuperseded(planId: string, version: number): AgentPlanContract {
    const plan = this.require(planId, version);
    return this.save({
      ...plan,
      planState: "superseded",
      updatedAt: new Date().toISOString(),
    });
  }

  markExecution(
    planId: string,
    version: number,
    executionState: AgentPlanContract["executionState"],
    note?: string,
  ): AgentPlanContract {
    const plan = this.require(planId, version);
    const activeStepIndex = plan.steps.findIndex((step) =>
      step.status === "pending"
      || step.status === "in_progress"
      || step.status === "blocked");
    const steps = plan.steps.map((step, index) => {
      if (index !== activeStepIndex) return step;
      if (executionState === "in_progress") {
        const { blockingReason: _blockingReason, ...rest } = step;
        return { ...rest, status: "in_progress" as const };
      }
      if (executionState === "blocked") {
        return {
          ...step,
          status: "blocked" as const,
          ...(note ? { blockingReason: note } : {}),
        };
      }
      if (executionState === "failed") {
        return {
          ...step,
          status: "failed" as const,
          ...(note ? { blockingReason: note } : {}),
        };
      }
      return step;
    });
    return this.save({
      ...plan,
      executionState,
      steps,
      blockingReasons: executionState === "in_progress"
        ? plan.blockingReasons.filter((reason) => !reason.startsWith("执行暂停："))
        : note
          ? [...plan.blockingReasons, note].slice(-32)
          : plan.blockingReasons,
      updatedAt: new Date().toISOString(),
    });
  }

  applyExecutionReport(
    planId: string,
    version: number,
    reportInput: AgentPlanExecutionReport,
  ): AgentPlanContract {
    const plan = this.require(planId, version);
    const evaluation = evaluateAgentPlanExecutionReport(plan, reportInput);
    if (!evaluation.acceptable || !evaluation.report) {
      throw new AgentPlanQualityError(evaluation.issues);
    }
    const reportByStep = new Map(
      evaluation.report.steps.map((step) => [step.stepId, step]),
    );
    const hasDeviation = evaluation.report.steps.some((step) => step.deviations.length > 0);
    const hasFailed = evaluation.report.steps.some((step) => step.status === "failed");
    const hasBlocked = evaluation.report.steps.some((step) =>
      step.status === "blocked" || step.status === "pending");
    const executionState: AgentPlanContract["executionState"] = hasFailed
      ? "failed"
      : hasBlocked || hasDeviation
        ? "blocked"
        : "completed";
    const reportBlockingReasons = evaluation.report.steps.flatMap((step) => [
      ...(step.blockingReason ? [step.blockingReason] : []),
      ...step.deviations.map((deviation) =>
        `步骤 ${step.stepId} 偏离已批准范围：${deviation}`),
    ]);
    return this.save({
      ...plan,
      executionState,
      steps: plan.steps.map((step) => {
        const report = reportByStep.get(step.id)!;
        const { blockingReason: _blockingReason, ...baseStep } = step;
        return {
          ...baseStep,
          status: report.status,
          actualScope: report.actualScope,
          evidence: report.evidence,
          deviations: report.deviations,
          ...(report.blockingReason ? { blockingReason: report.blockingReason } : {}),
        };
      }),
      blockingReasons: [
        ...plan.blockingReasons.filter((reason) =>
          !reason.startsWith("执行暂停：") && !reason.startsWith("步骤 ")),
        ...reportBlockingReasons,
      ].slice(-32),
      updatedAt: new Date().toISOString(),
    });
  }

  private require(planId: string, version: number): AgentPlanContract {
    const plan = this.get(planId, version);
    if (!plan) throw new AgentPlanVersionError(`计划 ${planId} v${version} 不存在。`);
    return plan;
  }

  private save(plan: AgentPlanContract): AgentPlanContract {
    const parsed = AgentPlanContractSchema.parse(plan);
    if (this.db) {
      this.db.prepare(
        `INSERT INTO agent_plan_contracts(
           plan_id, version, session_id, run_id, plan_state, execution_state,
           payload_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_id, version) DO UPDATE SET
           session_id=excluded.session_id,
           run_id=excluded.run_id,
           plan_state=excluded.plan_state,
           execution_state=excluded.execution_state,
           payload_json=excluded.payload_json,
           updated_at=excluded.updated_at`,
      ).run(
        parsed.planId,
        parsed.version,
        parsed.sessionId ?? null,
        parsed.sourceRunId,
        parsed.planState,
        parsed.executionState,
        JSON.stringify(parsed),
        parsed.createdAt,
        parsed.updatedAt,
      );
      return clone(parsed)!;
    }
    this.plans.set(key(parsed.planId, parsed.version), clone(parsed)!);
    return clone(parsed)!;
  }
}

export const defaultAgentPlanStore = new AgentPlanStore();

function parseRow(row: AgentPlanRow | undefined): AgentPlanContract | null {
  if (!row) return null;
  const plan = AgentPlanContractSchema.parse(JSON.parse(row.payload_json));
  if (
    plan.planId !== row.plan_id
    || plan.version !== Number(row.version)
    || plan.sourceRunId !== row.run_id
    || (plan.sessionId ?? null) !== row.session_id
    || plan.planState !== row.plan_state
    || plan.executionState !== row.execution_state
  ) {
    throw new AgentPlanVersionError("计划契约索引列与 payload 不一致。");
  }
  return clone(plan);
}

function key(planId: string, version: number): string {
  return `${planId}:${version}`;
}

function clone(plan: AgentPlanContract | null): AgentPlanContract | null {
  return plan ? AgentPlanContractSchema.parse(structuredClone(plan)) : null;
}
