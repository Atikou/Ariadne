import { ProductionMcpAgentClient } from '../../adapters/mcp/ProductionMcpAgentClient.js';
import { SandboxWorkspaceLspService } from '../../adapters/code-intelligence/SandboxWorkspaceLspService.js';
import { AgentLiveWorkService } from '../../control/resources/AgentLiveWorkService.js';
import { AgentProcessLiveWorkProducer } from '../../control/resources/AgentProcessLiveWorkProducer.js';
import { AgentTerminalLiveWorkProducer } from '../../control/resources/AgentTerminalLiveWorkProducer.js';
import type { ShutdownContext } from '../../ingress/ShutdownContext.js';
import { createBrowserAgentToolRegistrations } from '../first-party-tools/BrowserAgentTools.js';
import { createComputerReadAgentToolRegistrations } from '../first-party-tools/ComputerReadAgentTools.js';
import { createLiveWorkAgentToolRegistrations } from '../first-party-tools/LiveWorkAgentTools.js';
import { createMcpAgentToolRegistrations } from '../first-party-tools/McpAgentTools.js';
import { createProtectedResultAgentToolRegistrations } from '../first-party-tools/ProtectedResultAgentTools.js';
import { createWorkspaceAgentToolRegistrations } from '../first-party-tools/WorkspaceAgentTools.js';
import {
  defineRuntimeCapabilityProvider,
  type RuntimeCapabilityHandle,
  type RuntimeCapabilityProvider,
  type RuntimeCapabilityStartContext
} from './RuntimeCapabilityProvider.js';

export function firstPartyAgentCapabilityProviders(): readonly RuntimeCapabilityProvider[] {
  return Object.freeze([
    defineRuntimeCapabilityProvider({
      id: 'computer.read-tools',
      dependsOn: ['agent.control'],
      publicCapabilities: ['computer.read'],
      start: (context) => ({
        publicCapabilities: ['computer.read'],
        tools: createComputerReadAgentToolRegistrations(context.hostCapabilities)
      })
    }),
    defineRuntimeCapabilityProvider({
      id: 'workspace.tools',
      dependsOn: ['computer.read-tools'],
      publicCapabilities: ['workspace.read', 'workspace.write'],
      start: createWorkspaceToolCapability
    }),
    defineRuntimeCapabilityProvider({
      id: 'workspace.live-work',
      dependsOn: ['workspace.tools'],
      provides: [{ serviceId: 'agent.live-work', optional: false }],
      publicCapabilities: ['live.work'],
      start: createLiveWorkCapability
    }),
    defineRuntimeCapabilityProvider({
      id: 'browser.tools',
      dependsOn: ['agent.control'],
      publicCapabilities: ['browser.web'],
      start: (context) => ({
        publicCapabilities: context.bootstrap.agentPermissions?.allowedPermissions
          .includes('network') === true ? ['browser.web'] : [],
        tools: createBrowserAgentToolRegistrations(
          context.hostCapabilities,
          context.workspaceBindings
        )
      })
    }),
    defineRuntimeCapabilityProvider({
      id: 'mcp.tools',
      dependsOn: ['agent.control'],
      publicCapabilities: ['mcp.tools'],
      start: (context) => {
        const mcp = new ProductionMcpAgentClient(
          context.authorizedMcpServers,
          context.hostCapabilities,
          undefined,
          context.processSandboxFactory
        );
        return {
          publicCapabilities: context.authorizedMcpServers.length > 0 ? ['mcp.tools'] : [],
          tools: createMcpAgentToolRegistrations(mcp, context.workspaceBindings)
        };
      }
    }),
    defineRuntimeCapabilityProvider({
      id: 'agent.tools',
      dependsOn: ['workspace.live-work', 'browser.tools', 'mcp.tools', 'skills.catalog'],
      publicCapabilities: ['agent.tools'],
      start: () => ({ publicCapabilities: ['agent.tools'] })
    }),
    defineRuntimeCapabilityProvider({
      id: 'agent.subagents',
      dependsOn: ['agent.tools'],
      publicCapabilities: ['agent.subagents'],
      start: (context) => ({
        publicCapabilities: context.bootstrap.agentAdmissionAuthoritySource.status === 'enabled'
          ? ['agent.subagents'] : []
      })
    })
  ]);
}

function createWorkspaceToolCapability(
  context: RuntimeCapabilityStartContext
): RuntimeCapabilityHandle {
  const lsp = context.processSandboxFactory === undefined
    ? undefined
    : new SandboxWorkspaceLspService(context.processSandboxFactory);
  return {
    publicCapabilities: [
      'workspace.read',
      ...(context.bootstrap.workspaces.some((workspace) => workspace.access === 'write')
        ? ['workspace.write' as const] : [])
    ],
    tools: [
      ...createProtectedResultAgentToolRegistrations(context.workspaceBindings),
      ...createWorkspaceAgentToolRegistrations(
        context.workspaceBindings,
        context.processSandboxFactory,
        lsp
      )
    ],
    ...(lsp === undefined ? {} : {
      close: async (shutdown: ShutdownContext) => {
        await lsp.close();
        shutdown.throwIfExpired('workspace_lsp_shutdown_deadline_exceeded');
      }
    })
  };
}

function createLiveWorkCapability(context: RuntimeCapabilityStartContext): RuntimeCapabilityHandle {
  const liveWork = new AgentLiveWorkService();
  const processes = new AgentProcessLiveWorkProducer(liveWork, context.processSandboxFactory);
  const terminals = new AgentTerminalLiveWorkProducer(liveWork, context.processSandboxFactory);
  const enabled = context.processSandboxFactory !== undefined
    && context.bootstrap.agentPermissions?.allowedPermissions.includes('shell') === true
    && [...context.workspaceBindings.values()].some((workspace) => workspace.access === 'write');
  return {
    publicCapabilities: enabled ? ['live.work'] : [],
    tools: createLiveWorkAgentToolRegistrations(
      context.workspaceBindings,
      liveWork,
      processes,
      terminals
    ),
    services: { 'agent.live-work': liveWork },
    close: async (shutdown: ShutdownContext) => liveWork.close(shutdown.remainingMs())
  };
}
