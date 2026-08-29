import type {
  AgentBudgetVector,
  AgentCapabilityGrant
} from '@ariadne/agent-core';
import type {
  AgentAdmissionAuthoritySourceManifest
} from '@ariadne/protocol/host';
import type {
  ConversationMessageExecutionV3
} from '@ariadne/protocol/public';

const PLAN_TOOL_NAMES = new Set([
  'browser.accessibility_snapshot',
  'browser.navigate',
  'browser.wait',
  'computer.list_directory',
  'computer.open_path',
  'computer.read_text_file',
  'skill.load',
  'skill.resource.read',
  'workspace.list_files',
  'workspace.read_file'
]);

/**
 * The one production compiler from configured root authority to the authority
 * that an individual execution may actually persist. Plan execution is an
 * attenuated grant, not a prompt-only convention or a second Tool filter.
 */
export function compileEffectiveAgentExecutionAuthority(
  manifest: AgentAdmissionAuthoritySourceManifest,
  execution: ConversationMessageExecutionV3
): {
  readonly workspaceAccess: 'read' | 'write';
  readonly capabilities: readonly AgentCapabilityGrant[];
  readonly allowedToolNames: readonly string[];
  readonly budget: AgentBudgetVector;
} | null {
  if (execution.mode === 'agent') {
    return {
      workspaceAccess: manifest.workspace.access,
      capabilities: cloneCapabilities(manifest.capabilityGrant.capabilities),
      allowedToolNames: [...manifest.toolCatalog.allowedToolNames],
      budget: { ...manifest.rootBudget.vector }
    };
  }

  const modeToolNames = execution.mode === 'chat'
    ? manifest.toolCatalog.allowedToolNames.filter((name) => name.startsWith('computer.'))
    : manifest.toolCatalog.allowedToolNames.filter((name) => PLAN_TOOL_NAMES.has(name));

  const allowedToolNames = modeToolNames;
  const requiredCapabilities = new Set<string>();
  if (allowedToolNames.some((name) => name.startsWith('computer.'))) {
    requiredCapabilities.add('computer.read');
  }
  if (allowedToolNames.some((name) => name.startsWith('workspace.'))) {
    requiredCapabilities.add('workspace.read');
  }
  if (allowedToolNames.some((name) => name.startsWith('browser.'))) {
    requiredCapabilities.add('browser.use');
  }
  if (allowedToolNames.some((name) => name.startsWith('skill.'))) {
    requiredCapabilities.add('skills.read');
  }
  const capabilities = manifest.capabilityGrant.capabilities
    .filter((grant) => requiredCapabilities.has(grant.capabilityId))
    .map((grant) => ({
      capabilityId: grant.capabilityId,
      scopeIds: [...grant.scopeIds]
    }));
  const grantedCapabilities = new Set(
    capabilities.map((grant) => grant.capabilityId)
  );
  const capabilityCompleteTools = allowedToolNames.filter((name) => (
    (!name.startsWith('workspace.') || grantedCapabilities.has('workspace.read'))
    && (!name.startsWith('browser.') || grantedCapabilities.has('browser.use'))
    && (!name.startsWith('computer.') || grantedCapabilities.has('computer.read'))
    && (!name.startsWith('skill.') || grantedCapabilities.has('skills.read'))
  ));
  if (capabilities.length === 0 || capabilityCompleteTools.length === 0) {
    return null;
  }
  return {
    workspaceAccess: 'read',
    capabilities,
    allowedToolNames: capabilityCompleteTools,
    budget: {
      ...manifest.rootBudget.vector,
      writeCalls: 0,
      shellCalls: 0
    }
  };
}

function cloneCapabilities(
  capabilities: readonly AgentCapabilityGrant[]
): readonly AgentCapabilityGrant[] {
  return capabilities.map((grant) => ({
    capabilityId: grant.capabilityId,
    scopeIds: [...grant.scopeIds]
  }));
}
