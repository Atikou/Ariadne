import type { ApiResult } from "../core/apiResult.js";
import type { ToolPermission } from "../core/permissions.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { WorkspaceCatalog } from "../config/workspaceCatalog.js";
import type { TraceEvent, TraceLogger } from "../trace/TraceLogger.js";
import type { AgentProposalDraft } from "./AgentProposalDraftContracts.js";
import {
  AgentProposalPermissionValidationError,
  type AgentProposalCapabilityPolicy,
} from "./AgentProposalCapabilityPolicy.js";
import { toPublicError } from "../util/publicError.js";
import {
  AgentProposalRespondInputSchema,
  AgentProposalResponseSchema,
  ExplicitAgentProposalRequestSchema,
  type AgentCapability,
  type AgentExecutionOutcome,
  type AgentModelBinding,
  type AgentProposal,
  type AgentProposalCreateInput,
  type AgentProposalListFilter,
  type AgentProposalRespondInput,
  type AgentProposalResponse,
  type AgentSessionReadGrant,
  type ExplicitAgentProposalRequest,
} from "./AgentHandoffContracts.js";
import {
  AgentHandoffConflictError,
  AgentHandoffStateCenter,
  AgentHandoffValidationError,
  type CompanionSessionAccessRetirement,
} from "./AgentHandoffStateCenter.js";

export interface AgentHandoffExecutorInput {
  proposalId: string;
  grantId: string;
  originalRequest: string;
  interpretedTask: string;
  agentSessionId: string;
  workspaceKey: string;
  grantedPermissions: ToolPermission[];
  modelBinding?: AgentModelBinding;
}

export interface AgentHandoffCoordinatorDeps {
  state: AgentHandoffStateCenter;
  proposalCapabilityPolicy: Pick<AgentProposalCapabilityPolicy, "normalize">;
  contextManager: Pick<ContextManager, "createSession" | "getSession">;
  workspaceCatalog: WorkspaceCatalog;
  executeAgent(input: AgentHandoffExecutorInput): Promise<ApiResult>;
  trace?: TraceLogger;
}

/**
 * One-way conversation-to-Agent coordinator. It owns proposals and grants, but never
 * lets Companion hold an AgentLoop or executable tool handle.
 */
export class AgentHandoffCoordinator {
  constructor(private readonly deps: AgentHandoffCoordinatorDeps) {}

  submitProposal(
    input: AgentProposalCreateInput,
    binding?: { companionStorageRoot: string },
  ): AgentProposal {
    const workspace = this.requireWorkspace(input.workspaceKey);
    const proposal = this.deps.state.create({
      ...input,
      ...(binding ? { companionStorageRoot: binding.companionStorageRoot } : {}),
      workspaceKey: workspace.id,
      requestedScope: [workspace.resolvedRoot],
    });
    this.writeTrace({
      type: "assistant_agent_proposal_created",
      proposalId: proposal.id,
      sourceTurnId: proposal.sourceTurnId,
      companionSessionId: proposal.companionSessionId,
      requestedCapabilities: proposal.requestedCapabilities,
      risk: proposal.risk,
      workspaceKey: proposal.workspaceKey,
      modelSelectionMode: proposal.modelBinding?.selectionMode ?? "automatic",
      requestedClientName: proposal.modelBinding?.clientName,
      requestedModelName: proposal.modelBinding?.modelName,
      protocolVersion: proposal.modelBinding?.protocolVersion,
    });
    return proposal;
  }

  submitFromCompanion(input: {
    sourceTurnId: string;
    companionSessionId: string;
    companionStorageRoot: string;
    originalRequest: string;
    workspaceKey?: string;
    draft: AgentProposalDraft;
    source?: {
      protocolVersion: string;
      transport: "tool_call" | "text_envelope";
      selectionMode?: "automatic" | "manual";
      requestedClientName?: string;
      clientName: string;
      modelName: string;
      responseHash: string;
    };
  }): AgentProposal {
    const workspace = this.requireWorkspace(
      input.workspaceKey ?? this.deps.workspaceCatalog.defaultKey,
    );
    let draft: AgentProposalDraft;
    try {
      draft = this.deps.proposalCapabilityPolicy.normalize({
        originalRequest: input.originalRequest,
        draft: input.draft,
      });
    } catch (error) {
      const publicError = toPublicError(error, "Agent 提案权限校验失败");
      this.writeTrace({
        type: "assistant_agent_proposal_permission_error",
        level: "error",
        category: "companion.proposal.permission",
        message: publicError.message,
        companionSessionId: input.companionSessionId,
        metadata: {
          lifecycleStage: "permission_validation",
          errorCode: publicError.code,
          retryable: false,
          fieldPaths: error instanceof AgentProposalPermissionValidationError
            ? error.fieldIssues.map((issue) => issue.path)
            : [],
          fieldIssues: error instanceof AgentProposalPermissionValidationError
            ? error.fieldIssues
            : [],
          ...(input.source ?? {}),
        },
      });
      throw error;
    }
    let modelBinding: AgentModelBinding | undefined;
    try {
      modelBinding = modelBindingFromCompanionSource(input.source);
    } catch (error) {
      const publicError = toPublicError(error, "Agent 模型绑定校验失败");
      this.writeTrace({
        type: "assistant_agent_model_binding_error",
        level: "error",
        category: "assistant.agent.routing",
        message: publicError.message,
        companionSessionId: input.companionSessionId,
        metadata: {
          lifecycleStage: "model_binding_validation",
          errorCode: publicError.code,
          retryable: false,
          requestedClientName: input.source?.requestedClientName ?? null,
          resolvedClientName: input.source?.clientName ?? null,
          modelName: input.source?.modelName ?? null,
          protocolVersion: input.source?.protocolVersion ?? null,
          responseHash: input.source?.responseHash ?? null,
        },
      });
      throw error;
    }
    return this.submitProposal({
      sourceTurnId: input.sourceTurnId,
      companionSessionId: input.companionSessionId,
      originalRequest: input.originalRequest,
      reason: draft.reason,
      interpretedTask: draft.interpretedTask,
      requestedCapabilities: draft.requestedCapabilities,
      requestedScope: [workspace.resolvedRoot],
      risk: draft.risk,
      workspaceKey: workspace.id,
      ...(modelBinding ? { modelBinding } : {}),
    }, { companionStorageRoot: input.companionStorageRoot });
  }

  submitExplicit(rawInput: ExplicitAgentProposalRequest): AgentProposal {
    const input = ExplicitAgentProposalRequestSchema.parse(rawInput);
    const workspace = this.requireWorkspace(input.workspaceKey ?? this.deps.workspaceCatalog.defaultKey);
    return this.submitProposal({
      sourceTurnId: input.sourceTurnId,
      companionSessionId: input.companionSessionId,
      reason: "用户显式要求将当前请求交给临时 Agent 处理",
      originalRequest: input.originalRequest,
      interpretedTask: input.originalRequest,
      requestedCapabilities: input.requestedCapabilities,
      requestedScope: [workspace.resolvedRoot],
      risk: inferRisk(input.requestedCapabilities),
      workspaceKey: workspace.id,
    });
  }

  get(id: string): AgentProposal | null {
    return this.deps.state.get(id);
  }

  getByRunId(runId: string): AgentProposal | null {
    return this.deps.state.getByRunId(runId);
  }

  getActiveByAgentSessionId(agentSessionId: string): AgentProposal | null {
    return this.deps.state.getActiveByAgentSessionId(agentSessionId);
  }

  getCompanionStorageRoot(proposalId: string): string | undefined {
    return this.deps.state.getCompanionStorageRoot(proposalId);
  }

  getLinkedAgentSession(companionSessionId: string) {
    return this.deps.state.getLinkedAgentSession(companionSessionId);
  }

  listPending(filter?: AgentProposalListFilter): AgentProposal[] {
    return this.deps.state.listPending(filter);
  }

  retireCompanionSession(input: {
    companionSessionId: string;
    storageRoot?: string;
  }) {
    const retired = this.deps.state.retireCompanionSession(input);
    this.writeTrace({
      type: "assistant_companion_session_access_retired",
      companionSessionId: input.companionSessionId,
      deletionIntentId: retired.deletion.id,
      revokedSessionReadGrantId: retired.revokedSessionReadGrantId,
      rejectedProposalIds: retired.rejectedProposalIds,
      removedAgentSessionLink: retired.removedAgentSessionLink,
    });
    return retired;
  }

  listPendingCompanionSessionDeletions(): CompanionSessionAccessRetirement[] {
    return this.deps.state.listPendingCompanionSessionDeletions();
  }

  completeCompanionSessionDeletion(retirement: CompanionSessionAccessRetirement): void {
    this.deps.state.completeCompanionSessionDeletion(retirement);
    this.writeTrace({
      type: "assistant_companion_session_deletion_completed",
      companionSessionId: retirement.deletion.companionSessionId,
      deletionIntentId: retirement.deletion.id,
    });
  }

  restoreCompanionSession(retirement: CompanionSessionAccessRetirement): void {
    this.deps.state.restoreCompanionSession(retirement);
    this.writeTrace({
      type: "assistant_companion_session_access_restored",
      companionSessionId: retirement.rollback.companionSessionId,
      deletionIntentId: retirement.deletion.id,
      restoredSessionReadGrantId: retirement.revokedSessionReadGrantId,
      restoredProposalIds: retirement.rejectedProposalIds,
      restoredAgentSessionLink: retirement.removedAgentSessionLink,
    });
  }

  getApplicableSessionReadGrant(proposalId: string): AgentSessionReadGrant | null {
    const proposal = this.deps.state.get(proposalId);
    if (!proposal || !isSessionReadOnlyProposal(proposal) || !proposal.companionSessionId) {
      return null;
    }
    const grant = this.deps.state.getSessionReadGrant(proposal.companionSessionId);
    if (
      !grant
      || grant.status !== "active"
      || grant.workspaceKey !== proposal.workspaceKey
      || !sameStringSet(grant.allowedScope, proposal.requestedScope)
    ) {
      return null;
    }
    return grant;
  }

  async tryUseSessionReadGrant(proposalId: string): Promise<AgentProposalResponse | null> {
    const proposal = this.deps.state.get(proposalId);
    if (!proposal || proposal.status !== "pending") return null;
    const sessionReadGrant = this.getApplicableSessionReadGrant(proposal.id);
    if (!sessionReadGrant) return null;
    return this.approveAndExecute(
      proposal,
      ["file-read"],
      "session_read_reuse",
      sessionReadGrant,
    );
  }

  recordResumedExecution(runId: string, result: ApiResult): AgentProposal | null {
    const proposal = this.deps.state.getByRunId(runId);
    if (!proposal) return null;
    const execution = normalizeExecutionResult(result);
    if (execution.runId !== runId) {
      throw new AgentHandoffConflictError("Agent 恢复结果与提案绑定的 Run 不一致");
    }
    if (
      execution.outcome.status === "waiting_permission"
      || execution.outcome.status === "waiting_plan_handoff"
      || (result.status >= 500 && asRecord(result.body).retryable === true)
    ) {
      return proposal;
    }
    const settled = this.deps.state.settleActiveRun({
      runId,
      status: execution.outcome.status,
      outcome: execution.outcome,
    });
    if (settled) {
      this.writeTrace({
        type: "assistant_agent_proposal_resumed_settled",
        proposalId: settled.id,
        grantId: settled.grantId,
        runId,
        status: settled.status,
      });
    }
    return settled;
  }

  async respond(
    proposalId: string,
    rawInput: AgentProposalRespondInput,
  ): Promise<AgentProposalResponse | null> {
    const input = AgentProposalRespondInputSchema.parse(rawInput);
    const proposal = this.deps.state.get(proposalId);
    if (!proposal || proposal.status !== "pending") return null;
    if (input.decision === "reject") {
      const rejected = this.deps.state.reject(proposalId);
      if (!rejected) return null;
      this.writeTrace({
        type: "assistant_agent_proposal_rejected",
        proposalId: rejected.id,
        companionSessionId: rejected.companionSessionId,
      });
      return AgentProposalResponseSchema.parse({ proposal: rejected });
    }

    const workspaceKey = input.workspaceKey ?? proposal.workspaceKey;
    if (workspaceKey !== proposal.workspaceKey) {
      throw new AgentHandoffValidationError("批准作用域必须与提案展示并确认的工作区一致");
    }
    this.requireWorkspace(workspaceKey);
    if (input.decision === "allow_session_read_only" && !isSessionReadOnlyProposal(proposal)) {
      throw new AgentHandoffValidationError(
        "本会话只读授权只适用于能力恰好为 file-read 的只读提案",
      );
    }
    const capabilities = input.decision === "allow_session_read_only"
      ? ["file-read"] as AgentCapability[]
      : input.allowedCapabilities ?? proposal.requestedCapabilities;
    return this.approveAndExecute(
      proposal,
      capabilities,
      input.decision === "allow_session_read_only" ? "session_read_create" : "approve_once",
    );
  }

  private async approveAndExecute(
    proposal: AgentProposal,
    capabilities: AgentCapability[],
    authorizationMode: "approve_once" | "session_read_create" | "session_read_reuse",
    reusedSessionReadGrant?: AgentSessionReadGrant,
  ): Promise<AgentProposalResponse | null> {
    const workspace = this.requireWorkspace(proposal.workspaceKey);
    const agentSessionId = this.ensureAgentSession(proposal, workspace.id);
    const approved = this.deps.state.approve({
      proposalId: proposal.id,
      agentSessionId,
      allowedCapabilities: capabilities,
      createSessionReadGrant: authorizationMode === "session_read_create",
    });
    if (!approved) return null;
    const sessionReadGrant = approved.sessionReadGrant ?? reusedSessionReadGrant;
    const started = this.deps.state.beginExecution(proposal.id);
    this.writeTrace({
      type: "assistant_agent_grant_consumed",
      proposalId: proposal.id,
      grantId: started.grant.id,
      agentSessionId,
      allowedCapabilities: started.grant.allowedCapabilities,
      allowedPermissions: started.grant.allowedPermissions,
      workspaceKey: workspace.id,
      authorizationMode,
      sessionReadGrantId: sessionReadGrant?.id,
      modelSelectionMode: proposal.modelBinding?.selectionMode ?? "automatic",
      requestedClientName: proposal.modelBinding?.clientName,
      requestedModelName: proposal.modelBinding?.modelName,
      protocolVersion: proposal.modelBinding?.protocolVersion,
    });

    let apiResult: ApiResult;
    try {
      apiResult = await this.deps.executeAgent({
        proposalId: proposal.id,
        grantId: started.grant.id,
        originalRequest: proposal.originalRequest,
        interpretedTask: proposal.interpretedTask,
        agentSessionId,
        workspaceKey: workspace.id,
        grantedPermissions: started.grant.allowedPermissions,
        ...(proposal.modelBinding ? { modelBinding: proposal.modelBinding } : {}),
      });
    } catch (error) {
      const publicError = toPublicError(error, "Agent 启动失败");
      apiResult = {
        status: 502,
        body: { error: publicError.message, code: publicError.code },
      };
    }

    const execution = normalizeExecutionResult(apiResult);
    const active = execution.runId
      ? this.deps.state.bindExecutionRun(proposal.id, execution.runId)
      : started.proposal;
    let current = active;
    if (
      execution.outcome.status === "completed"
      || execution.outcome.status === "failed"
    ) {
      current = this.deps.state.settle({
          proposalId: proposal.id,
          status: execution.outcome.status,
          runId: execution.runId,
          outcome: execution.outcome,
        });
    }
    const terminal = current !== active;
    this.writeTrace({
      type: terminal ? "assistant_agent_proposal_settled" : "assistant_agent_run_bound",
      proposalId: proposal.id,
      grantId: started.grant.id,
      runId: execution.runId,
      status: terminal ? execution.outcome.status : "executing",
      ...(terminal ? {} : { waitReason: execution.outcome.status }),
    });
    return AgentProposalResponseSchema.parse({
      proposal: current,
      grant: started.grant,
      ...(sessionReadGrant ? { sessionReadGrant } : {}),
      ...(execution.runId ? { execution: { runId: execution.runId, outcome: execution.outcome } } : {}),
    });
  }

  private ensureAgentSession(proposal: AgentProposal, workspaceKey: string): string {
    if (proposal.companionSessionId) {
      const linked = this.deps.state.getLinkedAgentSession(proposal.companionSessionId);
      if (linked) {
        if (linked.workspaceKey !== workspaceKey) {
          throw new AgentHandoffConflictError("同一助手会话不能在 Agent 启动后切换工作区");
        }
        if (this.deps.contextManager.getSession(linked.agentSessionId)) return linked.agentSessionId;
      }
    }
    const session = this.deps.contextManager.createSession(
      "统一助手执行会话",
      workspaceKey,
      workspaceKey,
    );
    if (proposal.companionSessionId) {
      this.deps.state.linkAgentSession({
        companionSessionId: proposal.companionSessionId,
        agentSessionId: session.id,
        workspaceKey,
      });
    }
    return session.id;
  }

  private requireWorkspace(workspaceKey: string) {
    const entry = this.deps.workspaceCatalog.byId.get(workspaceKey);
    if (!entry) throw new AgentHandoffValidationError("Agent 提案只能请求已配置的工作区");
    return entry;
  }

  private writeTrace(event: Record<string, unknown>): void {
    try {
      this.deps.trace?.write(event as TraceEvent);
    } catch {
      // Proposal audit is best-effort and cannot mutate authorization state.
    }
  }
}

function inferRisk(capabilities: readonly AgentCapability[]): "read-only" | "write" {
  return capabilities.some((capability) => capability === "file-write" || capability === "shell")
    ? "write"
    : "read-only";
}

function isSessionReadOnlyProposal(proposal: AgentProposal): boolean {
  return proposal.risk === "read-only"
    && proposal.requestedCapabilities.length === 1
    && proposal.requestedCapabilities[0] === "file-read";
}

function modelBindingFromCompanionSource(source: {
  protocolVersion: string;
  selectionMode?: "automatic" | "manual";
  requestedClientName?: string;
  clientName: string;
  modelName: string;
} | undefined): AgentModelBinding | undefined {
  if (!source || source.selectionMode !== "manual") return undefined;
  const requestedClientName = source.requestedClientName?.trim();
  if (!requestedClientName) {
    throw new AgentHandoffValidationError("手动模型选择缺少可执行的客户端绑定");
  }
  if (requestedClientName !== source.clientName) {
    throw new AgentHandoffConflictError(
      `手动选择的模型客户端 ${requestedClientName} 与实际响应客户端 ${source.clientName} 不一致`,
    );
  }
  return {
    selectionMode: "manual",
    clientName: requestedClientName,
    modelName: source.modelName,
    protocolVersion: source.protocolVersion,
  };
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function normalizeExecutionResult(result: ApiResult): {
  runId?: string;
  outcome: AgentExecutionOutcome;
} {
  const body = asRecord(result.body);
  const runId = nonEmptyString(body.runId);
  const taskId = nonEmptyString(body.taskId);
  const error = nonEmptyString(body.error);
  if (result.status < 200 || result.status >= 300 || !runId) {
    return {
      ...(runId ? { runId } : {}),
      outcome: {
        status: "failed",
        ...(error ? { error } : { error: "Agent 未能启动或没有返回可审计 Run" }),
        ...(taskId ? { taskId } : {}),
      },
    };
  }

  const executionMeta = asRecord(body.executionMeta);
  const stopReason = nonEmptyString(executionMeta.stopReason);
  const answer = typeof body.answer === "string" ? body.answer.slice(0, 32_000) : undefined;
  const permissionRequest = asRecord(body.permissionRequest);
  const planHandoff = asRecord(body.planHandoff);
  const permissionRequestId = nonEmptyString(permissionRequest.id);
  const planHandoffId = nonEmptyString(planHandoff.id);
  const evidence = collectExecutionEvidence(body.steps);
  const status = stopReason === "awaiting_permission"
    ? "waiting_permission" as const
    : stopReason === "awaiting_plan_handoff"
      ? "waiting_plan_handoff" as const
      : stopReason === "completed"
        ? "completed" as const
        : "failed" as const;
  return {
    runId,
    outcome: {
      status,
      ...(answer !== undefined ? { answer } : {}),
      ...(taskId ? { taskId } : {}),
      ...(evidence.facts.length ? { facts: evidence.facts } : {}),
      ...(evidence.files.length ? { files: evidence.files } : {}),
      ...(evidence.errors.length ? { errors: evidence.errors } : {}),
      ...(status === "failed"
        ? { error: error ?? `Agent 未完成：${stopReason ?? "missing_stop_reason"}` }
        : {}),
      ...(status === "waiting_permission" && permissionRequestId
        ? { permissionRequestId }
        : {}),
      ...(status === "waiting_plan_handoff" && planHandoffId
        ? { planHandoffId }
        : {}),
    },
  };
}

function collectExecutionEvidence(value: unknown): {
  facts: string[];
  files: Array<{ path: string; tool: string; operation: "read" | "write" | "dangerous" }>;
  errors: Array<{ tool?: string; message: string }>;
} {
  if (!Array.isArray(value)) return { facts: [], files: [], errors: [] };
  const facts = new Set<string>();
  const files = new Map<string, { path: string; tool: string; operation: "read" | "write" | "dangerous" }>();
  const errors: Array<{ tool?: string; message: string }> = [];
  for (const item of value.slice(0, 200)) {
    const step = asRecord(item);
    const tool = nonEmptyString(step.tool);
    const permission = nonEmptyString(step.permission);
    const path = nonEmptyString(step.outcomePath);
    const message = nonEmptyString(step.outcomeMessage);
    if (step.ok === true && message) facts.add(message.slice(0, 1_000));
    if (step.ok === true && tool && path && ["read", "write", "dangerous"].includes(permission ?? "")) {
      const operation = permission as "read" | "write" | "dangerous";
      files.set(`${operation}:${path}`, { path: path.slice(0, 2_048), tool, operation });
    }
    if (step.ok === false) {
      const failure = nonEmptyString(step.error) ?? message;
      if (failure) errors.push({ ...(tool ? { tool } : {}), message: failure.slice(0, 2_000) });
    }
  }
  return { facts: [...facts].slice(0, 100), files: [...files.values()].slice(0, 100), errors: errors.slice(0, 100) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
