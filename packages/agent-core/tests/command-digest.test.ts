import { describe, expect, it } from 'vitest';
import {
  canonicalizeAgentRunCommand,
  digestAgentRunCommand,
  type StartAgentRunCommand
} from '../src/index.js';
import { binding, startCommand } from './fixtures.js';

describe('AgentRun command identity', () => {
  it('normalizes object key order before computing SHA-256', async () => {
    const original = startCommand();
    const reordered: StartAgentRunCommand = {
      binding: {
        budget: {
          source: binding.budget.source,
          deadlineAt: binding.budget.deadlineAt,
          vector: {
            writeCalls: binding.budget.vector.writeCalls,
            toolCalls: binding.budget.vector.toolCalls,
            shellCalls: binding.budget.vector.shellCalls,
            readCalls: binding.budget.vector.readCalls,
            modelTurns: binding.budget.vector.modelTurns,
            costMicrousd: binding.budget.vector.costMicrousd
          },
          runId: binding.budget.runId,
          grantId: binding.budget.grantId
        },
        toolCatalog: {
          allowedToolNames: binding.toolCatalog.allowedToolNames,
          digest: binding.toolCatalog.digest,
          revision: binding.toolCatalog.revision,
          catalogId: binding.toolCatalog.catalogId
        },
        policy: {
          permissionMode: binding.policy.permissionMode,
          revision: binding.policy.revision,
          policyId: binding.policy.policyId
        },
        model: {
          settingsRevision: binding.model.settingsRevision,
          modelId: binding.model.modelId,
          providerId: binding.model.providerId
        },
        workspace: {
          access: binding.workspace.access,
          scopeIds: binding.workspace.scopeIds,
          grantDigest: binding.workspace.grantDigest,
          revision: binding.workspace.revision,
          workspaceId: binding.workspace.workspaceId
        },
        capabilities: binding.capabilities,
        objectiveRef: binding.objectiveRef,
        sessionId: binding.sessionId,
        bindingVersion: 3
      },
      occurredAt: original.occurredAt,
      runId: original.runId,
      commandId: original.commandId,
      kind: 'run.start'
    };

    expect(canonicalizeAgentRunCommand(reordered))
      .toBe(canonicalizeAgentRunCommand(original));
    await expect(digestAgentRunCommand(reordered))
      .resolves.toBe(await digestAgentRunCommand(original));
    await expect(digestAgentRunCommand(original))
      .resolves.toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('changes the digest when logical command content changes', async () => {
    const original = startCommand();
    const changed: StartAgentRunCommand = {
      ...original,
      binding: {
        ...original.binding,
        objectiveRef: {
          kind: 'conversation_message',
          messageId: 'message-2',
          messageVersion: 1,
          contentDigest: original.binding.objectiveRef.kind === 'conversation_message'
            ? original.binding.objectiveRef.contentDigest
            : `sha256:${'f'.repeat(64)}`
        }
      }
    };

    expect(await digestAgentRunCommand(changed))
      .not.toBe(await digestAgentRunCommand(original));
  });
});
