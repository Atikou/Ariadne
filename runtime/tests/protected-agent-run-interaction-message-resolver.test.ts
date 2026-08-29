import {
  admitAgentRun,
  assertValidAgentRun,
  digestAgentTurnInput,
  summarizeAgentTurnInput,
  type AgentRun,
  type AgentTurnInputModelData
} from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import {
  ProtectedAgentRunInteractionMessageResolver
} from '../src/composition/ProtectedAgentRunInteractionMessageResolver.js';

const RUN_ID = 'run-interaction-projection';
const SOURCE_TURN_ID = 'turn-interaction-source';
const SOURCE_ATTEMPT_ID = 'attempt-interaction-source';
const DIRECTIVE_DIGEST = `sha256:${'a'.repeat(64)}`;
const CONTENT_DIGEST = `sha256:${'b'.repeat(64)}`;
const INPUT: AgentTurnInputModelData = {
  messages: [{ kind: 'text', role: 'user', content: 'Initial request.' }],
  availableTools: []
};

describe('ProtectedAgentRunInteractionMessageResolver', () => {
  it('projects only a durably continued response and its claimed user input', async () => {
    const run = await continuedRun();
    const loadDirectivePayload = vi.fn(async () => 'Protected first response.');
    const messages = await new ProtectedAgentRunInteractionMessageResolver({
      loadDirectivePayload
    }).resolveInteractionMessages(run);

    expect(messages).toEqual([{
      messageId: expect.stringMatching(/^agent-interaction-assistant:/),
      turnId: 'turn-interaction-continuation',
      role: 'assistant',
      content: 'Protected first response.',
      occurredAt: at(2)
    }, {
      messageId: 'message-interaction-inbox',
      turnId: 'turn-interaction-continuation',
      role: 'system',
      content: 'Continue with this constraint.',
      occurredAt: at(3)
    }]);
    expect(loadDirectivePayload).toHaveBeenCalledWith({
      runId: RUN_ID,
      artifactId: 'response-interaction-source',
      kind: 'response_content',
      directiveDigest: DIRECTIVE_DIGEST,
      contentDigest: CONTENT_DIGEST
    });
  });

  it('reconstructs a protected user question followed by its exact claimed answer', async () => {
    const run = await answeredQuestionRun();
    const payload = {
      format: 'ariadne.user-question' as const,
      schemaVersion: 1 as const,
      prompt: 'Which deployment target should be used?',
      options: [
        { optionId: 'local', label: 'Local only' },
        {
          optionId: 'remote',
          label: 'Remote host',
          description: 'Requires network access.'
        }
      ]
    };
    const loadDirectivePayload = vi.fn(async () => payload);
    const messages = await new ProtectedAgentRunInteractionMessageResolver({
      loadDirectivePayload
    }).resolveInteractionMessages(run);

    expect(messages).toEqual([{
      messageId: expect.stringMatching(/^agent-interaction-assistant:/),
      turnId: 'turn-interaction-continuation',
      role: 'assistant',
      content: 'Which deployment target should be used?\n- Local only\n- Remote host: Requires network access.',
      occurredAt: at(2)
    }, {
      messageId: 'message-interaction-inbox',
      turnId: 'turn-interaction-continuation',
      role: 'user',
      content: 'local: Local only',
      occurredAt: at(3)
    }]);
    expect(loadDirectivePayload).toHaveBeenCalledWith({
      runId: RUN_ID,
      artifactId: 'question-interaction-source',
      kind: 'user_question',
      directiveDigest: DIRECTIVE_DIGEST,
      contentDigest: CONTENT_DIGEST
    });
  });
});

async function answeredQuestionRun(): Promise<AgentRun> {
  const base = await continuedRun();
  const assistantQuestion = 'Which deployment target should be used?\n- Local only\n- Remote host: Requires network access.';
  const answer = 'local: Local only';
  const continuationInput: AgentTurnInputModelData = {
    messages: [
      ...INPUT.messages,
      { kind: 'text', role: 'assistant', content: assistantQuestion },
      { kind: 'text', role: 'user', content: answer }
    ],
    availableTools: []
  };
  const continuation = base.turns[1]!;
  const run: AgentRun = {
    ...base,
    turns: [{
      ...base.turns[0]!,
      attempts: [{
        ...base.turns[0]!.attempts[0]!,
        state: {
          status: 'succeeded',
          finishedAt: at(2),
          directive: {
            kind: 'ask_user',
            decisionId: 'decision-interaction-source',
            questionRef: 'question-interaction-source',
            questionDigest: CONTENT_DIGEST
          },
          directiveDigest: DIRECTIVE_DIGEST
        }
      }]
    }, {
      ...continuation,
      intention: {
        ...continuation.intention,
        inputDigest: await digestAgentTurnInput(continuationInput),
        inputSummary: summarizeAgentTurnInput(continuationInput)
      }
    }],
    inbox: [{
      ...base.inbox[0]!,
      delivery: 'next_step',
      content: answer,
      source: {
        kind: 'user_question_answer',
        decisionId: 'decision-interaction-source',
        questionDigest: CONTENT_DIGEST
      }
    }]
  };
  assertValidAgentRun(run);
  return run;
}

async function continuedRun(): Promise<AgentRun> {
  const binding = {
    bindingVersion: 3 as const,
    sessionId: 'session-interaction',
    objectiveRef: {
      kind: 'conversation_message' as const,
      messageId: 'message-interaction-objective',
      messageVersion: 1,
      contentDigest: `sha256:${'c'.repeat(64)}`
    },
    workspace: {
      workspaceId: 'workspace-interaction',
      revision: 1,
      grantDigest: `sha256:${'d'.repeat(64)}`,
      access: 'read' as const,
      scopeIds: ['workspace']
    },
    model: {
      providerId: 'provider-interaction',
      modelId: 'model-interaction',
      settingsRevision: 1
    },
    policy: {
      policyId: 'policy-interaction',
      revision: 1,
      permissionMode: 'trusted' as const
    },
    capabilities: [],
    toolCatalog: {
      catalogId: 'catalog-interaction',
      revision: 1,
      digest: `sha256:${'e'.repeat(64)}`,
      allowedToolNames: []
    },
    budget: {
      grantId: 'grant-interaction',
      runId: RUN_ID,
      vector: {
        modelTurns: 4,
        toolCalls: 0,
        readCalls: 0,
        writeCalls: 0,
        shellCalls: 0,
        costMicrousd: 10_000
      },
      deadlineAt: '2031-01-01T00:00:00.000Z',
      source: { kind: 'root' as const }
    }
  };
  const inputDigest = await digestAgentTurnInput(INPUT);
  const admitted = admitAgentRun({
    kind: 'run.admit',
    commandId: 'admit-interaction',
    runId: RUN_ID,
    occurredAt: at(0),
    binding,
    turn: {
      cause: {
        kind: 'conversation_objective',
        messageId: binding.objectiveRef.messageId,
        messageVersion: 1,
        contentDigest: binding.objectiveRef.contentDigest
      },
      turnId: SOURCE_TURN_ID,
      attemptId: SOURCE_ATTEMPT_ID,
      providerIdempotencyKey: 'provider-interaction-source',
      inputDigest,
      inputSummary: summarizeAgentTurnInput(INPUT)
    }
  }).run;
  const continuationInput: AgentTurnInputModelData = {
    messages: [
      ...INPUT.messages,
      { kind: 'text', role: 'assistant', content: 'Protected first response.' },
      { kind: 'text', role: 'system', content: 'Continue with this constraint.' }
    ],
    availableTools: []
  };
  const continuationDigest = await digestAgentTurnInput(continuationInput);
  const run: AgentRun = {
    ...admitted,
    version: 4,
    state: { status: 'running', checkpointVersion: 4, enteredAt: at(3) },
    turns: [{
      ...admitted.turns[0]!,
      attempts: [{
        ...admitted.turns[0]!.attempts[0]!,
        state: {
          status: 'succeeded',
          finishedAt: at(2),
          directive: {
            kind: 'respond',
            contentRef: 'response-interaction-source',
            contentDigest: CONTENT_DIGEST
          },
          directiveDigest: DIRECTIVE_DIGEST
        }
      }]
    }, {
      turnId: 'turn-interaction-continuation',
      runId: RUN_ID,
      intention: {
        expectedRunVersion: 3,
        checkpointVersion: 4,
        cause: {
          kind: 'inbox_inputs',
          sourceTurnId: SOURCE_TURN_ID,
          sourceAttemptId: SOURCE_ATTEMPT_ID,
          sourceDirectiveDigest: DIRECTIVE_DIGEST,
          inputIds: ['input-interaction-inbox']
        },
        bindingVersion: 3,
        sessionId: binding.sessionId,
        objectiveRef: binding.objectiveRef,
        workspace: binding.workspace,
        model: binding.model,
        policy: binding.policy,
        capabilities: binding.capabilities,
        toolCatalog: binding.toolCatalog,
        budget: binding.budget,
        inputDigest: continuationDigest,
        inputSummary: summarizeAgentTurnInput(continuationInput)
      },
      attempts: [{
        attemptId: 'attempt-interaction-continuation',
        turnId: 'turn-interaction-continuation',
        runId: RUN_ID,
        providerIdempotencyKey: 'provider-interaction-continuation',
        cause: { kind: 'initial' },
        state: { status: 'intended', intendedAt: at(3) }
      }],
      createdAt: at(3)
    }],
    inbox: [{
      inputId: 'input-interaction-inbox',
      messageId: 'message-interaction-inbox',
      version: 1,
      delivery: 'next_turn',
      content: 'Continue with this constraint.',
      contentDigest: `sha256:${'f'.repeat(64)}`,
      source: {
        kind: 'live_work',
        jobId: 'job-interaction-inbox',
        workKind: 'process',
        status: 'completed'
      },
      queuedAt: at(1),
      updatedAt: at(3),
      state: 'claimed',
      claimedAt: at(3),
      claimedTurnId: 'turn-interaction-continuation'
    }],
    updatedAt: at(3)
  };
  assertValidAgentRun(run);
  return run;
}

function at(second: number): string {
  return `2030-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
}
