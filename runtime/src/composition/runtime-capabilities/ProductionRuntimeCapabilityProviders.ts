import { ProductionMcpAgentClient } from '../../adapters/mcp/ProductionMcpAgentClient.js';
import { createBrowserAgentToolRegistrations } from '../first-party-tools/BrowserAgentTools.js';
import { createMcpAgentToolRegistrations } from '../first-party-tools/McpAgentTools.js';
import { createWorkspaceAgentToolRegistrations } from '../first-party-tools/WorkspaceAgentTools.js';
import { defineRuntimeCapabilityProvider, type RuntimeCapabilityProvider } from './RuntimeCapabilityProvider.js';

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
      'agent.tools', ['workspace.tools', 'browser.tools', 'mcp.tools'],
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
    defineRuntimeCapabilityProvider(
      'skills.instructions', ['agent.control'], ['agent.instructions.skills'],
      ['skills.instructions'],
      (context) => ({
        publicCapabilities: context.bootstrap.runtimePolicy.skills.enabled.length > 0
          ? ['skills.instructions'] : []
      })
    ),
    defineRuntimeCapabilityProvider(
      'hooks.run-pre', ['agent.control'], ['agent.hooks.run-pre'], ['hooks.run-pre'],
      (context) => ({
        publicCapabilities: context.bootstrap.runtimePolicy.hooks.definitions.some(
          (hook) => hook.events.includes('run.pre')
        ) ? ['hooks.run-pre'] : []
      })
    )
  ]);
}
