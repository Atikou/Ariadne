import type {
  AgentAvailableTool,
  AgentPinnedToolIdentity,
  AgentRunBinding,
  StartAgentRunCommand
} from '../src/index.js';

export const TEST_EFFECT_INPUT_DIGEST = `sha256:${'b'.repeat(64)}`;
export const TEST_TOOL_CONTRACT_DIGEST = `sha256:${'c'.repeat(64)}`;
export const TEST_TOOL_CATALOG_PIN = {
  catalogId: 'catalog-1',
  revision: 1,
  digest: `sha256:${'a'.repeat(64)}`
} as const;
export const TEST_TOOL_CATALOG = {
  ...TEST_TOOL_CATALOG_PIN,
  allowedToolNames: ['workspace.read', 'workspace.write']
} as const;

export function testPinnedToolIdentity(
  toolName: string
): AgentPinnedToolIdentity {
  return {
    ...TEST_TOOL_CATALOG_PIN,
    toolName,
    toolVersion: '1.0.0',
    providerId: 'ariadne.builtin',
    contractDigest: TEST_TOOL_CONTRACT_DIGEST
  };
}

export function testAvailableTool(toolName: string): AgentAvailableTool {
  return {
    tool: testPinnedToolIdentity(toolName),
    capabilityIds: [toolName]
  };
}

export const binding: AgentRunBinding = {
  bindingVersion: 3,
  sessionId: 'session-1',
  objectiveRef: {
    kind: 'conversation_message',
    messageId: 'message-1',
    messageVersion: 1,
    contentDigest: `sha256:${'d'.repeat(64)}`
  },
  workspace: {
    workspaceId: 'workspace-1',
    revision: 1,
    grantDigest: `sha256:${'e'.repeat(64)}`,
    access: 'write',
    scopeIds: ['workspace']
  },
  model: {
    providerId: 'provider-1',
    modelId: 'model-1',
    settingsRevision: 1
  },
  policy: {
    policyId: 'policy-1',
    revision: 1,
    permissionMode: 'ask'
  },
  capabilities: [
    { capabilityId: 'workspace.read', scopeIds: ['workspace'] },
    { capabilityId: 'workspace.write', scopeIds: ['workspace'] }
  ],
  toolCatalog: TEST_TOOL_CATALOG,
  budget: {
    grantId: 'grant-run-1',
    runId: 'run-1',
    vector: {
      modelTurns: 20,
      toolCalls: 10,
      readCalls: 10,
      writeCalls: 10,
      shellCalls: 10,
      costMicrousd: 1_000_000
    },
    deadlineAt: '2026-08-01T00:00:00.000Z',
    source: { kind: 'root' }
  }
};

export function bindingForRun(runId: string): AgentRunBinding {
  return {
    ...binding,
    objectiveRef: { ...binding.objectiveRef },
    workspace: { ...binding.workspace, scopeIds: [...binding.workspace.scopeIds] },
    model: { ...binding.model },
    policy: { ...binding.policy },
    capabilities: binding.capabilities.map((capability) => ({
      capabilityId: capability.capabilityId,
      scopeIds: [...capability.scopeIds]
    })),
    toolCatalog: {
      ...binding.toolCatalog,
      allowedToolNames: [...binding.toolCatalog.allowedToolNames]
    },
    budget: {
      ...binding.budget,
      grantId: `grant-${runId}`,
      runId,
      vector: { ...binding.budget.vector },
      source: { kind: 'root' }
    }
  };
}

export function startCommand(
  commandId = 'command-start',
  runId = 'run-1'
): StartAgentRunCommand {
  return {
    kind: 'run.start',
    commandId,
    runId,
    occurredAt: '2026-07-31T00:00:00.000Z',
    binding: bindingForRun(runId)
  };
}

export function at(second: number): string {
  return `2026-07-31T00:00:${String(second).padStart(2, '0')}.000Z`;
}
