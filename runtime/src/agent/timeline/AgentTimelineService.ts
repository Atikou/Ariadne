import { randomUUID } from "node:crypto";

import { ActivityRunStore, buildActivityRunManifest } from "./ActivityRunStore.js";
import type { AgentEventBus } from "./AgentEventBus.js";
import { defaultActivityEventBus } from "./AgentEventBus.js";
import type {
  ActivityAgentRun,
  ActivityAgentStep,
  ActivityStepMetadata,
  AgentActivityEvent,
  CreateActivityRunInput,
  StartActivityStepInput,
} from "./types.js";

export interface AgentTimelineServiceOptions {
  workspaceRoot: string;
  bus?: AgentEventBus;
  onEvent?: (event: AgentActivityEvent) => void;
}

/** 统一封装 Activity Timeline 更新；AgentLoop 只调用本服务，不直接操作 UI。 */
export class AgentTimelineService {
  private readonly store: ActivityRunStore;
  private readonly workspaceRoot: string;
  private readonly bus: AgentEventBus;
  private readonly onEvent?: (event: AgentActivityEvent) => void;
  private run: ActivityAgentRun | null = null;
  private sessionId?: string;
  private readonly stepIndex = new Map<string, ActivityAgentStep>();

  constructor(opts: AgentTimelineServiceOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.store = new ActivityRunStore(opts.workspaceRoot);
    this.bus = opts.bus ?? defaultActivityEventBus;
    this.onEvent = opts.onEvent;
  }

  getRun(): ActivityAgentRun | null {
    return this.run;
  }

  createRun(input: CreateActivityRunInput): ActivityAgentRun {
    const now = Date.now();
    this.sessionId = input.sessionId;
    const run: ActivityAgentRun = {
      id: input.id,
      title: input.title ?? input.goal.slice(0, 80),
      goal: input.goal,
      status: "running",
      steps: [],
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      metadata: input.metadata,
    };
    this.run = run;
    this.store.saveRun(run);
    this.persistManifest();
    this.emit({ type: "run_started", run: { ...run } });
    return run;
  }

  startStep(input: StartActivityStepInput): ActivityAgentStep {
    const run = this.requireRun();
    const now = Date.now();
    const step: ActivityAgentStep = {
      id: `step_${randomUUID().slice(0, 8)}`,
      runId: input.runId,
      type: input.type,
      title: input.title,
      content: input.content,
      status: "running",
      startedAt: now,
      metadata: input.metadata,
    };
    run.steps.push(step);
    run.updatedAt = now;
    this.stepIndex.set(step.id, step);
    this.persistRun();
    this.emit({ type: "step_started", step: { ...step } });
    return step;
  }

  appendStepDelta(stepId: string, contentDelta: string): void {
    const run = this.requireRun();
    const step = this.stepIndex.get(stepId);
    if (!step) return;
    step.content = (step.content ?? "") + contentDelta;
    run.updatedAt = Date.now();
    this.persistRun();
    this.emit({ type: "step_delta", runId: run.id, stepId, contentDelta });
  }

  completeStep(
    stepId: string,
    result?: string,
    metadata?: Partial<ActivityStepMetadata>,
  ): void {
    const run = this.requireRun();
    const step = this.stepIndex.get(stepId);
    if (!step) return;
    const now = Date.now();
    const outcomeClass = metadata?.outcomeClass;
    step.status = outcomeClass === "observation_failure" ? "warning" : "success";
    step.endedAt = now;
    if (result) step.content = result;
    if (metadata) step.metadata = { ...step.metadata, ...metadata };
    run.updatedAt = now;
    this.persistRun();
    this.emit({
      type: "step_completed",
      runId: run.id,
      stepId,
      result,
      metadata,
    });
  }

  failStep(stepId: string, error: string, metadata?: Partial<ActivityStepMetadata>): void {
    const run = this.requireRun();
    const step = this.stepIndex.get(stepId);
    if (!step) return;
    const now = Date.now();
    step.status = "failed";
    step.endedAt = now;
    step.metadata = { ...step.metadata, ...metadata, errorMessage: error };
    run.updatedAt = now;
    this.persistRun();
    this.emit({ type: "step_failed", runId: run.id, stepId, error, metadata });
  }

  skipStep(stepId: string, reason?: string): void {
    const run = this.requireRun();
    const step = this.stepIndex.get(stepId);
    if (!step) return;
    step.status = "skipped";
    step.endedAt = Date.now();
    run.updatedAt = Date.now();
    this.persistRun();
    this.emit({ type: "step_skipped", runId: run.id, stepId, reason });
  }

  completeRun(summary: string): void {
    const run = this.requireRun();
    const now = Date.now();
    run.status = "success";
    run.endedAt = now;
    run.updatedAt = now;
    this.persistRun();
    this.emit({ type: "run_completed", runId: run.id, summary });
    this.store.saveSummary(run.id, buildSummaryMarkdown(run, summary));
  }

  partialCompleteRun(summary: string, title = "任务未完全完成"): void {
    const run = this.requireRun();
    const now = Date.now();
    run.status = "partial";
    run.endedAt = now;
    run.updatedAt = now;
    this.persistRun();
    const summaryStep = this.startStep({
      runId: run.id,
      type: "summary",
      title,
      content: summary.slice(0, 400),
    });
    this.completeStep(summaryStep.id, summary.slice(0, 500));
    this.emit({ type: "run_completed", runId: run.id, summary });
    this.store.saveSummary(run.id, buildSummaryMarkdown(run, summary));
  }

  failRun(error: string): void {
    const run = this.requireRun();
    const now = Date.now();
    run.status = "failed";
    run.endedAt = now;
    run.updatedAt = now;
    this.persistRun();
    this.emit({ type: "run_failed", runId: run.id, error });
    this.store.saveSummary(run.id, buildSummaryMarkdown(run, error, true));
  }

  cancelRun(reason?: string): void {
    const run = this.requireRun();
    const now = Date.now();
    run.status = "cancelled";
    run.endedAt = now;
    run.updatedAt = now;
    this.persistRun();
    this.emit({ type: "run_cancelled", runId: run.id, reason });
  }

  recordRawToolCall(record: Record<string, unknown>): void {
    const run = this.requireRun();
    this.store.appendRawToolCall(run.id, record);
  }

  recordCapabilityEscalation(input: {
    runId: string;
    title: string;
    content: string;
    metadata?: ActivityStepMetadata;
  }): ActivityAgentStep {
    const step = this.startStep({
      runId: input.runId,
      type: "escalation",
      title: input.title,
      content: input.content,
      metadata: input.metadata,
    });
    this.completeStep(step.id, input.content.slice(0, 500), input.metadata);
    return step;
  }

  private requireRun(): ActivityAgentRun {
    if (!this.run) throw new Error("Activity run 尚未创建");
    return this.run;
  }

  private persistRun(): void {
    if (!this.run) return;
    this.store.saveRun(this.run);
    this.persistManifest();
  }

  private persistManifest(): void {
    if (!this.run) return;
    this.store.saveManifest(
      buildActivityRunManifest(this.run, {
        workspaceRoot: this.workspaceRoot,
        sessionId: this.sessionId,
      }),
    );
  }

  private emit(event: AgentActivityEvent): void {
    if (this.run) this.store.appendEvent(this.run.id, event);
    this.bus.publish(event);
    this.onEvent?.(event);
    if (
      event.type === "run_completed" ||
      event.type === "run_failed" ||
      event.type === "run_cancelled"
    ) {
      this.bus.clearRun(this.run!.id);
    }
  }
}

function buildSummaryMarkdown(run: ActivityAgentRun, body: string, failed = false): string {
  const changed = run.steps
    .flatMap((s) => s.metadata?.changedFiles ?? [])
    .filter(Boolean);
  const files = [...new Set(changed)];
  return [
    "# AgentRun 总结",
    "",
    "## 任务目标",
    "",
    run.goal,
    "",
    "## 结果",
    "",
    failed ? `失败：${body}` : body,
    "",
    "## 执行步骤",
    "",
    ...run.steps.map((s) => `- [${s.status}] ${s.title}${s.content ? ` — ${s.content}` : ""}`),
    "",
    files.length ? "## 修改文件\n\n" + files.map((f) => `- ${f}`).join("\n") : "",
    "",
  ]
    .filter(Boolean)
    .join("\n");
}
