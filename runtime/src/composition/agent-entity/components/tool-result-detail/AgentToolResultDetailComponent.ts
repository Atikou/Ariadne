import type { RuntimeApplicationCommandResult } from '../../../../ingress/RuntimeApplication.js';
import type { RuntimeCommandEnvelope } from '../../../../ingress/RuntimeIngress.js';
import { completedPublicError } from '../../../AgentPublicCommandFailures.js';
import type { AgentControlExecutionPipeline } from '../../../ProductionAgentControlExecutionPipelineFactory.js';

type ToolResultDetailCommand = Extract<RuntimeCommandEnvelope['command'], {
  readonly kind: 'agent.tool_result.detail.get.v3';
}>;

export interface AgentToolResultDetailComponentInput {
  readonly executionPipeline?: AgentControlExecutionPipeline;
  readonly authorizedWorkspaceIds?: readonly string[];
}

export interface AgentToolResultDetailComponentHandle {
  execute(
    envelope: RuntimeCommandEnvelope,
    command: ToolResultDetailCommand
  ): Promise<RuntimeApplicationCommandResult>;
}

export function createAgentToolResultDetailComponent(
  input: AgentToolResultDetailComponentInput
): AgentToolResultDetailComponentHandle {
  const authorizedWorkspaces = new Set(input.authorizedWorkspaceIds ?? []);
  const handle: AgentToolResultDetailComponentHandle = {
    execute: async (
      envelope: RuntimeCommandEnvelope,
      command: ToolResultDetailCommand
    ): Promise<RuntimeApplicationCommandResult> => {
      envelope.signal.throwIfAborted();
      if (authorizedWorkspaces.size > 0 && !authorizedWorkspaces.has(command.workspaceId)) {
        return completedPublicError(
          envelope, 'workspace_not_authorized',
          'The Workspace is not authorized by this Runtime bootstrap.', false
        );
      }
      const pipeline = input.executionPipeline;
      if (pipeline?.protectedEffectResultReader === undefined) {
        return completedPublicError(
          envelope, 'agent_tool_result_unavailable',
          'The protected Tool result reader is unavailable.', false
        );
      }
      try {
        const detail = await pipeline.protectedEffectResultReader.read(command);
        const presentation = pipeline.toolPresentationResolver.resolveToolPresentation(detail.tool);
        if (presentation === null || detail.workspaceId !== command.workspaceId) {
          throw new Error('agent_protected_effect_result_presentation_unavailable');
        }
        return {
          outcome: { ok: true, result: {
            kind: 'agent.tool_result.detail.v3',
            runId: command.runId,
            workspaceId: detail.workspaceId,
            effectId: detail.effectId,
            toolCallId: detail.toolCallId,
            presentation,
            status: detail.status,
            digest: detail.digest,
            totalBytes: detail.totalBytes,
            cursor: detail.cursor,
            nextCursor: detail.nextCursor,
            content: detail.content,
            complete: detail.complete
          } },
          settlement: 'completed'
        };
      } catch (error) {
        envelope.signal.throwIfAborted();
        if (error instanceof Error && error.message.startsWith('agent_protected_effect_result_')) {
          return completedPublicError(
            envelope, 'agent_tool_result_unavailable',
            'The protected Tool result is unavailable for this Run and Workspace.', false
          );
        }
        throw error;
      }
    }
  };
  return Object.freeze(handle);
}
