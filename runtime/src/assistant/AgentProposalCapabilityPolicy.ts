import type { UserPermissionPolicy } from "../agent/RunPolicyTypes.js";
import { permissionsForPolicy } from "../agent/WorkflowCapability.js";
import { extractMessageContinuationSignals } from "../agent/routing/MessageSignalExtractor.js";
import type { ToolPermission } from "../core/permissions.js";
import {
  AgentProposalDraftSchema,
  type AgentProposalDraft,
} from "./AgentProposalDraftContracts.js";
import {
  capabilitiesToToolPermissions,
  type AgentCapability,
} from "./AgentHandoffContracts.js";

const CAPABILITY_ORDER: readonly AgentCapability[] = [
  "file-read",
  "file-write",
  "browser",
  "shell",
];

export interface AgentProposalCapabilityPolicyInput {
  originalRequest: string;
  draft: AgentProposalDraft;
}

export class AgentProposalPermissionValidationError extends Error {
  readonly code = "AGENT_PROPOSAL_PERMISSION_VALIDATION_ERROR";
  readonly retryable = false;

  constructor(
    message: string,
    readonly fieldIssues: Array<{ path: string; code: string; message: string }>,
  ) {
    super(message);
    this.name = "AgentProposalPermissionValidationError";
  }
}

/**
 * Treats the AI-proposed capabilities as the requested ceiling and intersects
 * them only with the host/user permission ceiling. The system enforces explicit
 * user boundaries, but it does not reinterpret the task to decide which tools
 * the AI should request.
 */
export class AgentProposalCapabilityPolicy {
  constructor(input: {
    permissionPolicy?: UserPermissionPolicy;
    browserAvailable?: () => boolean;
  } = {}) {
    this.permissionPolicy = input.permissionPolicy;
    this.browserAvailable = input.browserAvailable ?? (() => false);
  }

  private readonly permissionPolicy: UserPermissionPolicy | undefined;
  private readonly browserAvailable: () => boolean;

  normalize(input: AgentProposalCapabilityPolicyInput): AgentProposalDraft {
    const requestedPermissions = capabilitiesToToolPermissions(
      input.draft.requestedCapabilities,
    );
    const explicitlyReadOnly = extractMessageContinuationSignals(
      input.originalRequest,
    ).explicitReadonlyRequest;
    const effectivePermissionPolicy = explicitlyReadOnly
      ? "readOnly"
      : this.permissionPolicy ?? permissionPolicyForPermissions(requestedPermissions);
    const allowedPermissions = new Set(permissionsForPolicy(effectivePermissionPolicy));
    const requestedCapabilities = new Set(input.draft.requestedCapabilities);

    const effectiveCapabilities = CAPABILITY_ORDER.filter((capability) => {
      if (!requestedCapabilities.has(capability)) return false;
      if (capability === "file-read") return allowedPermissions.has("read");
      if (explicitlyReadOnly) return false;
      if (capability === "file-write") return allowedPermissions.has("write");
      if (capability === "browser") {
        return this.browserAvailable() && allowedPermissions.has("network");
      }
      return allowedPermissions.has("shell");
    });

    const hasSideEffects = effectiveCapabilities.some(
      (capability) => capability !== "file-read",
    );
    const hasDestructiveCapability = effectiveCapabilities.some(
      (capability) => capability === "file-write" || capability === "shell",
    );

    if (effectiveCapabilities.length === 0) {
      throw new AgentProposalPermissionValidationError(
        "用户权限边界不允许提案申请的任何能力",
        [{
          path: "requestedCapabilities",
          code: "permission_ceiling_empty",
          message: "所有请求能力均被当前用户、工作区或运行时权限边界拒绝",
        }],
      );
    }

    const normalized = AgentProposalDraftSchema.safeParse({
      ...input.draft,
      requestedCapabilities: effectiveCapabilities,
      risk: hasSideEffects
        ? input.draft.risk === "destructive" && hasDestructiveCapability
          ? "destructive"
          : "write"
        : "read-only",
    });
    if (!normalized.success) {
      throw new AgentProposalPermissionValidationError(
        "权限裁剪后的 Agent 提案不符合授权契约",
        normalized.error.issues.slice(0, 12).map((issue) => ({
          path: issue.path.map(String).join(".") || "$",
          code: issue.code,
          message: issue.message.slice(0, 512),
        })),
      );
    }
    return normalized.data;
  }
}

export function permissionPolicyForPermissions(
  permissions: readonly ToolPermission[],
): UserPermissionPolicy {
  if (permissions.includes("shell") || permissions.includes("network")) {
    return "confirmBeforeRun";
  }
  if (permissions.includes("write")) return "confirmBeforeEdit";
  return "readOnly";
}
