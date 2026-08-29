import { createHash } from 'node:crypto';

import {
  FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST,
  FIRST_PARTY_AGENT_TOOL_CATALOG_ID,
  FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION,
  FIRST_PARTY_AGENT_TOOL_NAMES,
  agentAdmissionAuthoritySourceSchema,
  type AgentAdmissionAuthoritySource,
  type AgentAdmissionAuthoritySourceManifest
} from '@ariadne/protocol/host';
import { COMPUTER_READ_SCOPE_ID } from '@ariadne/protocol/public';

export interface MainAdmissionWorkspaceConfiguration {
  readonly workspaceId: string;
  readonly access: 'read' | 'write';
  readonly kind: 'assistant' | 'agent';
  readonly archivedAt?: string | undefined;
}

export interface MainAdmissionModelProviderConfiguration {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly model: string;
}

export interface BuildAgentAdmissionAuthoritySourceInput {
  readonly settingsRevision: number;
  readonly permissionMode: 'request' | 'risk-based' | 'full-access' | 'custom';
  readonly allowedPermissions: readonly ('read' | 'write' | 'shell' | 'network' | 'dangerous')[];
  readonly workspaces: readonly MainAdmissionWorkspaceConfiguration[];
  readonly modelProviders: readonly MainAdmissionModelProviderConfiguration[];
  readonly localModelRoots?: readonly string[];
  readonly mcpEnabled?: boolean;
  readonly skillNames?: readonly string[];
  readonly now?: Date;
}

/**
 * Compiles the current first-party settings snapshot into complete admission
 * authority. There is no second manifest store and no Runtime-side fallback.
 */
export function buildAgentAdmissionAuthoritySource(
  input: BuildAgentAdmissionAuthoritySourceInput
): AgentAdmissionAuthoritySource {
  if (!Number.isSafeInteger(input.settingsRevision) || input.settingsRevision < 1) {
    return disabledSource('invalid_first_party_configuration');
  }
  const activeWorkspaces = input.workspaces.filter(
    (workspace) => workspace.archivedAt === undefined
  );
  const enabledModels = input.modelProviders.filter((provider) => provider.enabled);
  const authorizedModels = [
    ...enabledModels,
    ...((input.localModelRoots?.length ?? 0) > 0
      ? [{
          providerId: 'ariadne.local',
          enabled: true,
          model: '__runtime_selected_local__'
        }]
      : [])
  ];
  if (
    authorizedModels.length === 0
    || hasDuplicate(activeWorkspaces.map((workspace) => workspace.workspaceId))
    || hasDuplicate(input.modelProviders.map((provider) => provider.providerId))
  ) return disabledSource('not_configured');

  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    return disabledSource('invalid_first_party_configuration');
  }
  const deadlineAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1_000).toISOString();
  const model = authorizedModels[0]!;
  const manifests = activeWorkspaces.map((workspace) => createManifest({
    workspace,
    model,
    modelCandidates: authorizedModels,
    settingsRevision: input.settingsRevision,
    permissionMode: input.permissionMode,
    allowedPermissions: input.allowedPermissions,
    mcpEnabled: input.mcpEnabled === true,
    skillsEnabled: (input.skillNames?.length ?? 0) > 0,
    deadlineAt
  }));
  const parsed = agentAdmissionAuthoritySourceSchema.safeParse({
    sourceVersion: 1,
    status: 'enabled',
    manifests
  });
  return parsed.success
    ? structuredClone(parsed.data)
    : disabledSource('invalid_first_party_configuration');
}

function createManifest(input: {
  readonly workspace: MainAdmissionWorkspaceConfiguration;
  readonly model: MainAdmissionModelProviderConfiguration;
  readonly modelCandidates: readonly MainAdmissionModelProviderConfiguration[];
  readonly settingsRevision: number;
  readonly permissionMode: BuildAgentAdmissionAuthoritySourceInput['permissionMode'];
  readonly allowedPermissions: BuildAgentAdmissionAuthoritySourceInput['allowedPermissions'];
  readonly mcpEnabled: boolean;
  readonly skillsEnabled: boolean;
  readonly deadlineAt: string;
}): AgentAdmissionAuthoritySourceManifest {
  const { workspace, model, settingsRevision } = input;
  const workspaceScopeIds = [workspace.workspaceId];
  const computerScopeIds = [COMPUTER_READ_SCOPE_ID];
  const scopeIds = [...new Set([...workspaceScopeIds, ...computerScopeIds])].sort(compareCodeUnits);
  const permissionSet = new Set(input.allowedPermissions);
  const capabilityIds = (workspace.kind === 'assistant'
    ? ['computer.read']
    : [
        ...(permissionSet.has('network') ? ['browser.use'] : []),
        ...(input.mcpEnabled && permissionSet.has('network') ? ['mcp.use'] : []),
        ...(input.skillsEnabled ? ['skills.read'] : []),
        'computer.read',
        'workspace.read',
        ...(workspace.access === 'write' && permissionSet.has('shell')
          ? ['workspace.shell']
          : []),
        ...(workspace.access === 'write' && permissionSet.has('write')
          ? ['workspace.write']
          : [])
      ]).sort(compareCodeUnits);
  const capabilitySet = new Set(capabilityIds);
  const allowedToolNames = FIRST_PARTY_AGENT_TOOL_NAMES.filter((toolName) => (
    toolName.startsWith('computer.')
    || (workspace.kind === 'agent' && (
    toolName === 'workspace.list_files'
    || toolName === 'workspace.read_file'
    || toolName === 'workspace.effect_result_read'
    || (toolName === 'skill.load' && capabilitySet.has('skills.read'))
    || (
      (
        toolName === 'workspace.run_command'
        || toolName.startsWith('workspace.process_')
        || toolName.startsWith('workspace.terminal_')
        || toolName.startsWith('workspace.job_')
      )
      && capabilitySet.has('workspace.shell')
    )
    || (toolName === 'workspace.write_file' && capabilitySet.has('workspace.write'))
    || (toolName.startsWith('mcp.') && capabilitySet.has('mcp.use'))
    || (
      toolName.startsWith('browser.')
      && capabilitySet.has('browser.use')
      && (
        (toolName !== 'browser.download' && toolName !== 'browser.screenshot')
        || capabilitySet.has('workspace.write')
      )
    )
    ))
  ));
  const identity = `${workspace.workspaceId}:${String(settingsRevision)}`;
  return {
    manifestVersion: 1,
    manifestId: `workspace-manifest:${identity}`,
    revision: settingsRevision,
    workspace: {
      workspaceId: workspace.workspaceId,
      revision: settingsRevision,
      grantDigest: digestJson({ workspace, settingsRevision }),
      access: workspace.access,
      scopeIds
    },
    model: {
      providerId: model.providerId,
      modelId: model.model,
      settingsRevision
    },
    modelCandidates: input.modelCandidates.map((candidate) => ({
      providerId: candidate.providerId,
      modelId: candidate.model,
      settingsRevision
    })),
    policy: {
      policyId: `workspace-policy:${workspace.workspaceId}`,
      revision: settingsRevision,
      permissionMode: input.permissionMode === 'full-access' ? 'trusted' : 'ask'
    },
    capabilityGrant: {
      grantId: `workspace-grant:${identity}`,
      revision: settingsRevision,
      capabilities: capabilityIds.map((capabilityId) => ({
        capabilityId,
        scopeIds: capabilityId === 'computer.read' ? computerScopeIds : workspaceScopeIds
      }))
    },
    toolCatalog: {
      catalogId: FIRST_PARTY_AGENT_TOOL_CATALOG_ID,
      revision: FIRST_PARTY_AGENT_TOOL_CATALOG_REVISION,
      digest: FIRST_PARTY_AGENT_TOOL_CATALOG_DIGEST,
      allowedToolNames
    },
    rootBudget: {
      authorityId: `workspace-budget:${identity}`,
      revision: settingsRevision,
      vector: {
        modelTurns: 24,
        toolCalls: 64,
        readCalls: 48,
        writeCalls: capabilityIds.includes('workspace.write') ? 16 : 0,
        shellCalls: capabilityIds.includes('workspace.shell') ? 8 : 0,
        costMicrousd: 5_000_000
      },
      deadlinePolicy: { kind: 'absolute', deadlineAt: input.deadlineAt }
    }
  };
}

function digestJson(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function disabledSource(
  reason: Extract<AgentAdmissionAuthoritySource, { status: 'disabled' }>['reason']
): AgentAdmissionAuthoritySource {
  return Object.freeze({ sourceVersion: 1, status: 'disabled', reason });
}
