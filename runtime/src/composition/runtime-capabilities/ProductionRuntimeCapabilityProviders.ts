import { ProductionMcpAgentClient } from '../../adapters/mcp/ProductionMcpAgentClient.js';
import { createBrowserAgentToolRegistrations } from '../first-party-tools/BrowserAgentTools.js';
import { createMcpAgentToolRegistrations } from '../first-party-tools/McpAgentTools.js';
import { createProcessSessionAgentToolRegistrations } from '../first-party-tools/ProcessSessionAgentTools.js';
import { createWorkspaceAgentToolRegistrations } from '../first-party-tools/WorkspaceAgentTools.js';
import { AgentProcessSessionService } from '../../control/resources/AgentProcessSessionService.js';
import { defineRuntimeCapabilityProvider, type RuntimeCapabilityProvider } from './RuntimeCapabilityProvider.js';
import { agentExtensionCapabilityProviders } from './AgentExtensionCapabilityProviders.js';

export function productionRuntimeCapabilityProviders(): readonly RuntimeCapabilityProvider[] {
  return Object.freeze([
    defineRuntimeCapabilityProvider('runtime.kernel', [], ['runtime.kernel'], [
      'companion.chat', 'companion.agent-plan', 'companion.sessions',
      'models.local', 'models.remote'
    ], (context) => ({
      publicCapabilities: [
        'companion.chat', 'companion.agent-plan', 'companion.sessions',
        'models.local', 'models.remote'
      ]
    })),
    defineRuntimeCapabilityProvider('agent.control', ['runtime.kernel'], ['agent.control'], [
      'agent.runs', 'agent.inbox', 'agent.permissions', 'agent.plans'
    ], () => ({
      publicCapabilities: ['agent.runs', 'agent.inbox', 'agent.permissions', 'agent.plans']
    })),
    defineRuntimeCapabilityProvider(
      'workspace.tools', ['agent.control'], ['agent.tools.workspace'],
      ['workspace.read', 'workspace.write'],
      (context) => ({
        publicCapabilities: [
          'workspace.read',
          ...(context.bootstrap.workspaces.some((workspace) => workspace.access === 'write')
            ? ['workspace.write' as const] : [])
        ],
        tools: createWorkspaceAgentToolRegistrations(
          context.workspaceBindings,
          context.processSandboxFactory
        )
      })
    ),
    defineRuntimeCapabilityProvider(
      'workspace.process-sessions', ['workspace.tools'],
      ['agent.process-sessions'], ['background.tasks'],
      (context) => {
        const sessions = new AgentProcessSessionService(context.processSandboxFactory);
        const enabled = context.processSandboxFactory !== undefined
          && context.bootstrap.agentPermissions?.allowedPermissions.includes('shell') === true
          && [...context.workspaceBindings.values()].some((workspace) => workspace.access === 'write');
        return {
          publicCapabilities: enabled ? ['background.tasks'] : [],
          tools: createProcessSessionAgentToolRegistrations(context.workspaceBindings, sessions),
          services: { 'agent.process-sessions': sessions },
          close: async (shutdown) => sessions.close(shutdown.remainingMs())
        };
      }
    ),
    defineRuntimeCapabilityProvider(
      'browser.tools', ['agent.control'], ['agent.tools.browser'], ['browser.web'],
      (context) => ({
        publicCapabilities: context.bootstrap.agentPermissions?.allowedPermissions
          .includes('network') === true ? ['browser.web'] : [],
        tools: createBrowserAgentToolRegistrations(context.hostCapabilities, context.workspaceBindings)
      })
    ),
    defineRuntimeCapabilityProvider(
      'mcp.tools', ['agent.control'], ['agent.tools.mcp'], ['mcp.tools'],
      (context) => {
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
    ),
    defineRuntimeCapabilityProvider(
      'agent.tools', ['workspace.process-sessions', 'browser.tools', 'mcp.tools'],
      ['agent.tool-catalog'], ['agent.tools'],
      () => ({ publicCapabilities: ['agent.tools'] })
    ),
    defineRuntimeCapabilityProvider(
      'agent.subagents', ['agent.tools'], ['agent.subagents'], ['agent.subagents'],
      (context) => ({
        publicCapabilities: context.bootstrap.agentAdmissionAuthoritySource.status === 'enabled'
          ? ['agent.subagents'] : []
      })
    ),
    ...agentExtensionCapabilityProviders()
  ]);
}
