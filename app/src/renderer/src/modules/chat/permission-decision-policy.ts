import type { AgentCapability, PermissionRequest, WorkspaceAccessMode } from '@ariadne/protocol/public';

export type ApprovalScope = PermissionRequest['permissionItems'][number]['approvalScopes'][number];

export function capabilityAllowedInWorkspace(
  capability: AgentCapability,
  workspaceAccess: WorkspaceAccessMode
): boolean {
  return workspaceAccess === 'write' || capability === 'file-read' || capability === 'browser';
}

export function capabilitiesForWorkspaceAccess(
  capabilities: readonly AgentCapability[],
  workspaceAccess: WorkspaceAccessMode
): AgentCapability[] {
  return capabilities.filter((capability) => capabilityAllowedInWorkspace(capability, workspaceAccess));
}

export function commonApprovalScopes(
  items: PermissionRequest['permissionItems']
): ApprovalScope[] {
  if (items.length === 0) return [];
  return items[0]!.approvalScopes.filter((scope) => (
    items.every((item) => item.approvalScopes.includes(scope))
  ));
}
