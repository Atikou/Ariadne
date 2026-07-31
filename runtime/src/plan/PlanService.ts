import { randomUUID } from "node:crypto";

import type { Planner } from "../agent/Planner.js";
import { finalizePlan } from "../agent/taskGraph.js";
import type { Plan } from "../agent/types.js";
import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { PlanCompiler } from "./PlanCompiler.js";
import { bindPlanTools } from "./planToolBinder.js";
import { PlanApprovalManager } from "./PlanApprovalManager.js";
import { buildRenderedPreviews, renderPublicPlanJson } from "./PlanRenderer.js";
import { PlanStore } from "./PlanStore.js";
import { PlanValidator, canTransition } from "./PlanValidator.js";
import { internalPlanFromLegacy } from "./planConverter.js";
import {
  PlanValidationError,
  PublicPlanJsonSchema,
  type InternalTaskPlan,
  type PlanMode,
  type PlanStatus,
  type PublicPlanJson,
  type UserVisiblePlan,
} from "./types.js";

export interface PlanDraftRecord {
  planId: string;
  version: number;
  status: "awaiting_approval";
  planHash: string;
  previewMarkdown: string;
  publicPlanJson: PublicPlanJson;
}

export interface PlanServiceOptions {
  workspaceRoot: string;
  store: PlanStore;
  validator: PlanValidator;
  approval: PlanApprovalManager;
  registry: ToolRegistry;
  trace?: TraceLogger;
}

export class PlanService {
  private readonly compiler = new PlanCompiler();

  constructor(private readonly options: PlanServiceOptions) {}

  /**
   * Planner 输出 → InternalTaskPlan 草案（推荐入口）。
   * legacy `Plan` JSON 仅作为模型 IO 格式，落盘前必经 `internalPlanFromLegacy`。
   */
  async createDraftFromPlanner(input: {
    goal: string;
    context?: string;
    sessionId?: string;
    requestId?: string;
    mode?: PlanMode;
    planner: Planner;
  }): Promise<PlanDraftRecord> {
    const legacy = await input.planner.generateExecutablePlan(input.goal, input.context);
    return this.createDraftFromLegacyPlan(bindPlanTools(legacy, { registry: this.options.registry }), {
      sessionId: input.sessionId,
      requestId: input.requestId,
      mode: input.mode,
      originType: "planner",
    });
  }

  /** 可执行编译（带 tool/toolInput）→ InternalTaskPlan 草案。 */
  async createExecutableDraftFromPlanner(input: {
    goal: string;
    context?: string;
    sessionId?: string;
    requestId?: string;
    mode?: PlanMode;
    planner: Planner;
    originType?: InternalTaskPlan["origin"]["type"];
    planId?: string;
    version?: number;
  }): Promise<PlanDraftRecord> {
    const legacy = await input.planner.generateExecutablePlan(input.goal, input.context);
    return this.createDraftFromLegacyPlan(bindPlanTools(legacy, { registry: this.options.registry }), {
      sessionId: input.sessionId,
      requestId: input.requestId,
      mode: input.mode,
      originType: input.originType ?? "planner",
      planId: input.planId,
      version: input.version,
    });
  }

  createDraftFromLegacyPlan(
    legacy: Plan,
    meta: {
      sessionId?: string;
      requestId?: string;
      mode?: PlanMode;
      originType?: InternalTaskPlan["origin"]["type"];
      planId?: string;
      version?: number;
    },
  ): PlanDraftRecord {
    const draft = this.prepareDraftFromLegacyPlan(legacy, meta);
    const saved = this.options.store.save(draft, "planner_draft");
    this.logDraftCreated(saved.planId, saved.version);
    return this.toDraftRecord(saved);
  }

  /** @deprecated 使用 `createDraftFromLegacyPlan` */
  persistLegacyAsDraft(
    legacy: Plan,
    meta: Parameters<PlanService["createDraftFromLegacyPlan"]>[1],
  ): ReturnType<PlanService["createDraftFromLegacyPlan"]> {
    return this.createDraftFromLegacyPlan(legacy, meta);
  }

  async importPreviewAsRevision(input: {
    preview: PublicPlanJson | string;
    goal?: string;
    sessionId?: string;
    planId?: string;
    baseVersion?: number;
    planner: Planner;
  }): Promise<PlanDraftRecord & { supersededVersion?: number }> {
    let publicPreview: PublicPlanJson | undefined;
    let context: string;
    if (typeof input.preview === "string") {
      context = input.preview.trim();
    } else {
      const parsed = PublicPlanJsonSchema.safeParse(input.preview);
      if (!parsed.success) {
        throw new PlanValidationError("INVALID_SCHEMA", "preview 必须是严格 PublicPlanJson 或非空文本");
      }
      publicPreview = parsed.data;
      context = `用户导入的展示计划（不可执行）：${JSON.stringify(publicPreview)}`;
    }
    if (!context) {
      throw new PlanValidationError("INVALID_SCHEMA", "preview 不能为空");
    }
    const goal =
      input.goal?.trim() ||
      publicPreview?.title ||
      "根据用户导入内容修订计划";

    if (input.planId) {
      const baseVersion = input.baseVersion ?? this.options.store.getLatestVersion(input.planId);
      if (!baseVersion) {
        throw new PlanValidationError("PLAN_NOT_FOUND", "计划不存在");
      }
      return this.createInternalRevision({
        planId: input.planId,
        baseVersion,
        goal,
        context,
        sessionId: input.sessionId,
        planner: input.planner,
        originType: "import_preview",
      });
    }

    const legacy = await input.planner.generateExecutablePlan(goal, context);
    return this.createDraftFromLegacyPlan(bindPlanTools(legacy, { registry: this.options.registry }), {
      sessionId: input.sessionId,
      originType: "import_preview",
    });
  }

  async revisePlan(input: {
    planId: string;
    baseVersion?: number;
    revisionRequest: string;
    sessionId?: string;
    planner: Planner;
  }): Promise<PlanDraftRecord & { supersededVersion: number }> {
    const revisionRequest = input.revisionRequest.trim();
    if (!revisionRequest) {
      throw new PlanValidationError("INVALID_SCHEMA", "revisionRequest 不能为空");
    }
    const baseVersion = input.baseVersion ?? this.options.store.getLatestVersion(input.planId);
    if (!baseVersion) {
      throw new PlanValidationError("PLAN_NOT_FOUND", "计划不存在");
    }
    return this.createInternalRevision({
      planId: input.planId,
      baseVersion,
      goal: `修订计划 v${baseVersion}：${revisionRequest}`,
      context: revisionRequest,
      sessionId: input.sessionId,
      planner: input.planner,
      originType: "revision",
    });
  }

  async createInternalRevision(input: {
    planId: string;
    baseVersion: number;
    goal: string;
    context?: string;
    sessionId?: string;
    planner: Planner;
    originType?: InternalTaskPlan["origin"]["type"];
  }): Promise<PlanDraftRecord & { supersededVersion: number }> {
    const base = this.options.store.get(input.planId, input.baseVersion);
    if (!base) {
      throw new PlanValidationError("PLAN_NOT_FOUND", "计划不存在");
    }
    if (!canTransition(base.status, "superseded")) {
      throw new PlanValidationError(
        "PLAN_STATUS_CONFLICT",
        `计划状态 ${base.status} 不允许创建修订版`,
      );
    }
    const nextVersion = input.baseVersion + 1;
    if (this.options.store.get(input.planId, nextVersion)) {
      throw new PlanValidationError("PLAN_STATUS_CONFLICT", `版本 ${nextVersion} 已存在`);
    }

    const markdown = this.getPreview(input.planId, input.baseVersion, "markdown");
    const contextParts = [
      input.context,
      markdown ? `上一版 Markdown 预览（v${input.baseVersion}，不可执行）：\n${markdown}` : undefined,
    ].filter((part): part is string => Boolean(part));

    const legacy = await input.planner.generateExecutablePlan(
      input.goal,
      contextParts.join("\n\n"),
    );
    const bound = bindPlanTools(legacy, { registry: this.options.registry });
    const draft = this.prepareDraftFromLegacyPlan(bound, {
      planId: input.planId,
      version: nextVersion,
      sessionId: input.sessionId,
      originType: input.originType ?? "revision",
    });
    const committed = this.options.store.commitRevision({
      planId: input.planId,
      baseVersion: input.baseVersion,
      revision: draft,
    });
    this.logPlanEvent("plan.superseded", input.planId, input.baseVersion);
    this.logDraftCreated(committed.revision.planId, committed.revision.version);
    return {
      ...this.toDraftRecord(committed.revision),
      supersededVersion: input.baseVersion,
    };
  }

  private prepareDraftFromLegacyPlan(
    legacy: Plan,
    meta: {
      sessionId?: string;
      requestId?: string;
      mode?: PlanMode;
      originType?: InternalTaskPlan["origin"]["type"];
      planId?: string;
      version?: number;
    },
  ): InternalTaskPlan {
    const finalized = finalizePlan(legacy);
    const draft = internalPlanFromLegacy(finalized, {
      planId: meta.planId ?? randomUUID(),
      version: meta.version ?? 1,
      workspaceRoot: this.options.workspaceRoot,
      sessionId: meta.sessionId,
      requestId: meta.requestId,
      mode: meta.mode,
      originType: meta.originType,
      status: "draft",
    });
    const validated = this.options.validator.validate(draft);
    return { ...validated, status: "awaiting_approval" };
  }

  private toDraftRecord(saved: ReturnType<PlanStore["save"]>): PlanDraftRecord {
    if (saved.status !== "awaiting_approval") {
      throw new PlanValidationError("INVALID_SCHEMA", "持久计划草案状态无效");
    }
    const previews = buildRenderedPreviews(saved.internal);
    return {
      planId: saved.planId,
      version: saved.version,
      status: saved.status,
      planHash: saved.planHash,
      previewMarkdown: previews.markdown.content,
      publicPlanJson: renderPublicPlanJson(saved.internal),
    };
  }

  private logDraftCreated(planId: string, version: number): void {
    this.logPlanEvent("plan.created", planId, version);
    this.logPlanEvent("plan.validated", planId, version);
    this.logPlanEvent("plan.preview_rendered", planId, version);
  }

  getPlanSummary(planId: string): {
    planId: string;
    latestVersion: number;
    status: PlanStatus;
    goal: string;
    versions: ReturnType<PlanStore["listVersions"]>;
  } | null {
    const head = this.options.store.get(planId);
    if (!head) return null;
    return {
      planId,
      latestVersion: head.version,
      status: head.status,
      goal: head.goal,
      versions: this.options.store.listVersions(planId),
    };
  }

  approve(planId: string, version: number, approvedBy: string, comment?: string): InternalTaskPlan {
    const internal = this.options.approval.approve(planId, version, approvedBy, comment);
    this.logPlanEvent("plan.approved", planId, version, approvedBy);
    return internal;
  }

  reject(planId: string, version: number, approvedBy: string, comment?: string): InternalTaskPlan {
    const internal = this.options.approval.reject(planId, version, approvedBy, comment);
    this.logPlanEvent("plan.rejected", planId, version, approvedBy);
    return internal;
  }

  getRecord(planId: string, version: number) {
    return this.options.store.get(planId, version);
  }

  ensureApprovedForDryRun(planId: string, version: number): void {
    const record = this.options.store.get(planId, version);
    if (!record) throw new PlanValidationError("INVALID_SCHEMA", "计划不存在");
    if (record.status === "awaiting_approval" || record.status === "validated") {
      this.approve(planId, version, "system:dry-run", "auto before dry-run");
    }
  }

  createPlanRun(planId: string, version: number) {
    const run = this.options.store.createPlanRun({ planId, version, status: "running" });
    if (!this.options.store.updatePlanRun(run.id, { startedAt: new Date().toISOString() })) {
      throw new Error("更新 PlanRun started_at 失败");
    }
    return run;
  }

  finishPlanRun(
    planRunId: string,
    status: "completed" | "paused" | "cancelled" | "failed",
    stopReason: string,
  ): void {
    const updated = this.options.store.updatePlanRun(planRunId, {
      status,
      stopReason,
      finishedAt: new Date().toISOString(),
    });
    if (!updated) throw new Error("更新 PlanRun 终态失败");
  }

  resumePlanRun(planRunId: string): void {
    const updated = this.options.store.updatePlanRun(planRunId, {
      status: "running",
      finishedAt: null,
      stopReason: null,
    });
    if (!updated) throw new Error("恢复 PlanRun 失败");
  }

  loadExecutable(planId: string, version: number): InternalTaskPlan {
    const record = this.options.store.get(planId, version);
    if (!record) {
      throw new PlanValidationError("INVALID_SCHEMA", "计划不存在");
    }
    this.options.validator.assertExecutable(record.internal, record.planHash);
    return record.internal;
  }

  markRunning(planId: string, version: number): InternalTaskPlan {
    const updated = this.options.store.updateStatus(planId, version, "running");
    if (!updated) throw new Error("更新 running 失败");
    this.logPlanEvent("plan.execution_started", planId, version);
    return updated.internal;
  }

  markExecutionFinished(
    planId: string,
    version: number,
    status: "completed" | "paused" | "cancelled" | "failed",
  ): void {
    const updated = this.options.store.updateStatus(planId, version, status);
    if (!updated) throw new Error(`更新计划执行终态失败: ${status}`);
    const eventType = status === "completed"
      ? "plan.execution_completed"
      : status === "paused"
        ? "plan.execution_paused"
        : status === "cancelled"
          ? "plan.execution_cancelled"
          : "plan.execution_failed";
    this.logPlanEvent(eventType, planId, version);
  }

  getPreview(planId: string, version: number, format: "markdown" | "json"): string | null {
    const preview = this.options.store.getPreview(planId, version, format);
    return preview?.content ?? null;
  }

  saveUserVisiblePlan(plan: UserVisiblePlan): UserVisiblePlan {
    const saved = this.options.store.saveUserVisiblePlan(plan);
    this.options.trace?.write({
      type: "plan_event",
      eventType: "user_visible_plan.created",
      userVisiblePlanId: saved.id,
      sourceRunId: saved.sourceRunId,
      at: new Date().toISOString(),
    });
    return saved;
  }

  getUserVisiblePlan(id: string): UserVisiblePlan | null {
    return this.options.store.getUserVisiblePlan(id);
  }

  getLatestUserVisiblePlanForSession(sessionId: string): UserVisiblePlan | null {
    return this.options.store.getLatestUserVisiblePlanForSession(sessionId);
  }

  recordPlanRunStepStarted(input: {
    planRunId: string;
    stepId: string;
    toolName?: string;
  }): string {
    const rowId = this.options.store.createPlanRunStep({
      planRunId: input.planRunId,
      stepId: input.stepId,
      status: "running",
      toolName: input.toolName,
    });
    this.options.trace?.write({
      type: "plan_event",
      eventType: "plan.step_started",
      planRunId: input.planRunId,
      stepId: input.stepId,
      toolName: input.toolName,
      at: new Date().toISOString(),
    });
    return rowId;
  }

  recordPlanRunStepFinished(
    stepRowId: string,
    input: { status: string; error?: string; outputPreview?: string; planRunId?: string; stepId?: string },
  ): void {
    this.options.store.finishPlanRunStep(stepRowId, input);
    this.options.trace?.write({
      type: "plan_event",
      eventType:
        input.status === "completed" ? "plan.step_completed" : "plan.step_failed",
      planRunId: input.planRunId,
      stepId: input.stepId,
      status: input.status,
      error: input.error,
      at: new Date().toISOString(),
    });
  }

  recordPlanRunStepWaiting(
    stepRowId: string,
    input: { planRunId: string; stepId: string; childRunId: string; error: string },
  ): void {
    this.options.store.markPlanRunStepWaiting(stepRowId, input.error);
    this.options.trace?.write({
      type: "plan_event",
      eventType: "plan.step_waiting_agent",
      planRunId: input.planRunId,
      stepId: input.stepId,
      childRunId: input.childRunId,
      status: "waiting_agent",
      at: new Date().toISOString(),
    });
  }

  async compileUserVisiblePlan(input: {
    userVisiblePlanId: string;
    confirmedTodoIds: string[];
    sessionId?: string;
    requestId?: string;
    planner?: Planner;
  }): Promise<
    ReturnType<PlanService["createDraftFromLegacyPlan"]> & { sourceUserVisiblePlan: UserVisiblePlan }
  > {
    const userVisiblePlan = this.getUserVisiblePlan(input.userVisiblePlanId);
    if (!userVisiblePlan) {
      throw new PlanValidationError("PLAN_NOT_FOUND", "UserVisiblePlan 不存在");
    }
    const skeleton = this.compiler.compile({
      userVisiblePlan,
      confirmedTodoIds: input.confirmedTodoIds,
    });
    const executable = await this.resolveExecutablePlan({
      skeleton,
      userVisiblePlan,
      planner: input.planner,
    });
    const draft = this.createDraftFromLegacyPlan(executable, {
      sessionId: input.sessionId ?? userVisiblePlan.sessionId,
      requestId: input.requestId ?? userVisiblePlan.sourceRunId,
      mode: "implement",
      originType: "user_visible_plan",
    });
    this.options.trace?.write({
      type: "plan_event",
      eventType: "user_visible_plan.compiled",
      userVisiblePlanId: userVisiblePlan.id,
      planId: draft.planId,
      version: draft.version,
      at: new Date().toISOString(),
    });
    return { ...draft, sourceUserVisiblePlan: userVisiblePlan };
  }

  private async resolveExecutablePlan(input: {
    skeleton: Plan;
    userVisiblePlan: UserVisiblePlan;
    planner?: Planner;
  }): Promise<Plan> {
    const context = JSON.stringify({
      userVisiblePlanId: input.userVisiblePlan.id,
      title: input.userVisiblePlan.title,
      skeleton: input.skeleton,
    });
    let plan = input.skeleton;
    if (input.planner) {
      try {
        plan = await input.planner.generateExecutablePlan(input.skeleton.goal, context);
      } catch {
        plan = input.skeleton;
      }
    }
    const bound = bindPlanTools(plan, { registry: this.options.registry });
    const internalPreview = internalPlanFromLegacy(bound, {
      planId: "compile-preview",
      version: 1,
      workspaceRoot: this.options.workspaceRoot,
      originType: "user_visible_plan",
    });
    this.options.validator.assertToolBindings(internalPreview);
    return bound;
  }

  private logPlanEvent(
    eventType: string,
    planId: string,
    version: number,
    actor = "agent",
  ): void {
    this.options.trace?.write({
      type: "plan_event",
      eventType,
      planId,
      version,
      actor,
      at: new Date().toISOString(),
    });
  }
}
