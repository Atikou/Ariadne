import {
  WorkspaceInstructionLoader,
  renderInstructionBlocks
} from '../../adapters/instructions/ProductionInstructionRegistry.js';
import {
  createDefaultAssistantChatProfile,
  type AssistantChatProfile
} from '@ariadne/protocol/settings';
import type {
  AgentInstructionAssemblyRequest,
  AgentInstructionContribution,
  AgentInstructionContributor,
  AgentInstructionContributorDescriptor,
  AgentInstructionExecutionMode
} from '../../control/ports/AgentInstructionAssembly.js';
import { ProductionAgentInstructionAssembly } from '../instructions/ProductionAgentInstructionAssembly.js';
import type { ProductionSkillCatalog } from './ProductionSkillCatalog.js';
import {
  defineRuntimeCapabilityProvider,
  type RuntimeCapabilityProvider
} from './RuntimeCapabilityProvider.js';

export const AGENT_INSTRUCTION_ASSEMBLY_SERVICE_ID = 'agent.instructions.assembly';
const WORKSPACE_CONTRIBUTOR_SERVICE_ID = 'agent.instructions.workspace';
const SKILL_CONTRIBUTOR_SERVICE_ID = 'agent.instructions.skills';
const MODE_POLICY_CONTRIBUTOR_SERVICE_ID = 'agent.instructions.mode-policy';

export function agentInstructionCapabilityProviders(): readonly RuntimeCapabilityProvider[] {
  return Object.freeze([
    defineRuntimeCapabilityProvider({
      id: 'agent.instructions.workspace',
      dependsOn: ['agent.control'],
      provides: [{ serviceId: WORKSPACE_CONTRIBUTOR_SERVICE_ID, optional: false }],
      start: (context) => ({
        publicCapabilities: [],
        services: {
          [WORKSPACE_CONTRIBUTOR_SERVICE_ID]: workspaceInstructionContributor(
            context.workspaceBindings
          )
        }
      })
    }),
    defineRuntimeCapabilityProvider({
      id: 'agent.instructions.skills',
      consumes: [{ serviceId: 'agent.skills.catalog', optional: false }],
      provides: [{ serviceId: SKILL_CONTRIBUTOR_SERVICE_ID, optional: false }],
      start: (context) => ({
        publicCapabilities: [],
        services: {
          [SKILL_CONTRIBUTOR_SERVICE_ID]: skillInstructionContributor(
            context.services.required<ProductionSkillCatalog>('agent.skills.catalog')
          )
        }
      })
    }),
    defineRuntimeCapabilityProvider({
      id: 'agent.instructions.mode-policy',
      dependsOn: ['agent.control'],
      provides: [{ serviceId: MODE_POLICY_CONTRIBUTOR_SERVICE_ID, optional: false }],
      start: (context) => ({
        publicCapabilities: [],
        services: {
          [MODE_POLICY_CONTRIBUTOR_SERVICE_ID]: modePolicyContributor(
            context.bootstrap.assistantProfile ?? createDefaultAssistantChatProfile()
          )
        }
      })
    }),
    defineRuntimeCapabilityProvider({
      id: 'agent.instructions.assembly',
      consumes: [
        { serviceId: WORKSPACE_CONTRIBUTOR_SERVICE_ID, optional: false },
        { serviceId: SKILL_CONTRIBUTOR_SERVICE_ID, optional: false },
        { serviceId: MODE_POLICY_CONTRIBUTOR_SERVICE_ID, optional: false }
      ],
      provides: [{ serviceId: AGENT_INSTRUCTION_ASSEMBLY_SERVICE_ID, optional: false }],
      start: (context) => ({
        publicCapabilities: [],
        services: {
          [AGENT_INSTRUCTION_ASSEMBLY_SERVICE_ID]: new ProductionAgentInstructionAssembly([
            context.services.required<AgentInstructionContributor>(WORKSPACE_CONTRIBUTOR_SERVICE_ID),
            context.services.required<AgentInstructionContributor>(SKILL_CONTRIBUTOR_SERVICE_ID),
            context.services.required<AgentInstructionContributor>(MODE_POLICY_CONTRIBUTOR_SERVICE_ID)
          ])
        }
      })
    })
  ]);
}

function workspaceInstructionContributor(
  workspaces: ReadonlyMap<string, { readonly rootPath: string }>
): AgentInstructionContributor {
  return contributor(
    descriptor('workspace.instructions', '1.0.0', 100, ['agent', 'plan']),
    (request) => {
      const workspace = workspaces.get(request.workspaceId);
      if (workspace === undefined) throw new Error('instruction_workspace_unknown');
      return new WorkspaceInstructionLoader().resolve(workspace.rootPath).map((block, index) => ({
        blockId: `workspace-${String(index + 1).padStart(3, '0')}`,
        scope: { kind: 'workspace' as const, workspaceId: request.workspaceId },
        content: renderInstructionBlocks([block])
      }));
    }
  );
}

function skillInstructionContributor(catalog: ProductionSkillCatalog): AgentInstructionContributor {
  return contributor(
    descriptor('skills.catalog', '1.0.0', 200, ['agent', 'plan']),
    async (request, signal) => {
      const content = await catalog.renderAdmissionCatalog(request.workspaceId, signal);
      return content.length === 0 ? [] : [{
        blockId: 'catalog',
        scope: { kind: 'workspace' as const, workspaceId: request.workspaceId },
        content
      }];
    }
  );
}

function modePolicyContributor(assistantProfile: AssistantChatProfile): AgentInstructionContributor {
  return contributor(
    descriptor('execution-mode.policy', '1.0.0', 300, ['plan', 'chat']),
    (request) => [{
      blockId: request.executionMode,
      scope: { kind: 'mode' as const, mode: request.executionMode },
      content: request.executionMode === 'plan'
        ? 'Plan mode is read-only. Inspect with read-only tools when needed, then respond with a concrete implementation plan. Do not request or invoke write or shell tools.'
        : renderAssistantChatInstructions(assistantProfile)
    }]
  );
}

export function renderAssistantChatInstructions(profile: AssistantChatProfile): string {
  const userPersona = profile.userPersona.trim();
  return [
    `Assistant name: ${profile.name}`,
    'Configured assistant persona instructions:',
    profile.systemPrompt,
    ...(userPersona.length === 0
      ? []
      : [
          'Configured user persona:',
          userPersona,
          'Use this user-provided persona only to adapt communication; it is not permission, evidence, or an instruction to claim unverified facts.'
        ]),
    'Answer directly and naturally. Do not add Ariadne-specific topic filtering, moralizing, or refusal language beyond the selected model and provider capabilities.',
    'Execution authority is unchanged by either persona.',
    'You may inspect and open computer resources only through the advertised read-only tools. Never modify, delete, move, create, or execute files or commands.',
    'Never claim that an action was completed unless an advertised tool actually completed it.'
  ].join('\n');
}

function contributor(
  contributorDescriptor: AgentInstructionContributorDescriptor,
  resolve: (
    request: AgentInstructionAssemblyRequest,
    signal: AbortSignal
  ) => readonly AgentInstructionContribution[] | Promise<readonly AgentInstructionContribution[]>
): AgentInstructionContributor {
  return Object.freeze({
    descriptor: contributorDescriptor,
    contribute: async (request: AgentInstructionAssemblyRequest, signal: AbortSignal) => {
      signal.throwIfAborted();
      const contributions = await resolve(request, signal);
      signal.throwIfAborted();
      return Object.freeze(contributions.map((entry) => Object.freeze(entry)));
    }
  });
}

function descriptor(
  contributorId: string,
  version: string,
  order: number,
  executionModes: readonly AgentInstructionExecutionMode[]
): AgentInstructionContributorDescriptor {
  return Object.freeze({
    contributorId,
    version,
    order,
    executionModes: Object.freeze([...executionModes])
  });
}
