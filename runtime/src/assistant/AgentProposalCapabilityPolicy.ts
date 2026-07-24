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

/**
 * Treats the AI-proposed capabilities as the requested ceiling and intersects
 * them only with the host/user permission ceiling. The system enforces explicit
 * user boundaries, but it does not reinterpret the task to decide which tools
 * the AI should request.
 */
export class AgentProposalCapabilityPolicy {
  constructor(input: {
    permissionPolicy?: UserPermissionPolicy;
  } = {}) {
    this.permissionPolicy = input.permissionPolicy;
  }

  private readonly permissionPolicy: UserPermissionPolicy | undefined;

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
      if (capability === "browser") return allowedPermissions.has("network");
      return allowedPermissions.has("shell");
    });

    const hasSideEffects = effectiveCapabilities.some(
      (capability) => capability !== "file-read",
    );
    const hasDestructiveCapability = effectiveCapabilities.some(
      (capability) => capability === "file-write" || capability === "shell",
    );

    return AgentProposalDraftSchema.parse({
      ...input.draft,
      requestedCapabilities: effectiveCapabilities,
      risk: hasSideEffects
        ? input.draft.risk === "destructive" && hasDestructiveCapability
          ? "destructive"
          : "write"
        : "read-only",
    });
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
