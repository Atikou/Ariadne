import type {
  PublicDecisionProjectionV3,
  PublicInferenceStreamProjectionV3,
  PublicRunProjectionV3
} from '@ariadne/protocol/public';
import { describe, expect, it } from 'vitest';

import {
  presentInferenceStreamMessage,
  presentPermissionDecision,
  presentPlanDecision,
  presentRunActivities,
  presentUserQuestionDecision
} from '../src/renderer/src/core/runtime/runtime-projection-presenter';

const REQUESTED_AT = '2032-01-01T00:00:00.000Z';
const ACTION: NonNullable<PublicDecisionProjectionV3['action']> = {
  contractVersion: '1.0' as const,
  actionToken: `decision-action.v1:${'a'.repeat(64)}`,
  choices: ['allow_once', 'allow_run', 'deny']
};

describe('runtime projection Decision presenter', () => {
  it('uses contract-pinned Tool labels and kinds without inventing result detail', () => {
    const run: PublicRunProjectionV3 = {
      runId: 'run-tool-presentation',
      sessionId: 'session-tool-presentation',
      sourceMessageId: 'message-tool-presentation',
      version: 2,
      title: 'Agent run',
      status: 'running',
      label: '正在处理',
      toolActivities: [{
        activityId: 'effect-tool-presentation',
        callId: 'tool-call-public',
        toolName: 'workspace.write_file',
        presentation: {
          kind: 'file_change',
          label: '写入工作区文件'
        },
        status: 'completed',
        occurredAt: REQUESTED_AT,
        completedAt: REQUESTED_AT
      }],
      inbox: [],
      interactionMessages: [],
      updatedAt: REQUESTED_AT,
      startedAt: REQUESTED_AT
    };

    expect(presentRunActivities(run)).toEqual([expect.objectContaining({
      toolName: 'workspace.write_file',
      title: '写入工作区文件',
      presentationKind: 'file_change',
      detailAvailable: false,
      changedFileCount: 0
    })]);
  });

  it('presents only an open exact-attempt stream and keeps reasoning separate', () => {
    const stream: PublicInferenceStreamProjectionV3 = {
      inferenceStreamId: 'stream-run-a-turn-a-attempt-a',
      runId: 'run-a',
      turnId: 'turn-a',
      attemptId: 'attempt-a',
      version: 2,
      status: 'streaming',
      retainedFromSequence: 1,
      finalSequence: 2,
      chunks: [{
        sequence: 1,
        channel: 'reasoning',
        text: '分析中',
        observedAt: REQUESTED_AT
      }, {
        sequence: 2,
        channel: 'token',
        text: '可公开的回答',
        observedAt: REQUESTED_AT
      }],
      updatedAt: REQUESTED_AT
    };
    const run = {
      runId: 'run-a',
      sessionId: 'session-a'
    } as PublicRunProjectionV3;

    expect(presentInferenceStreamMessage(stream, run)).toMatchObject({
      messageId: stream.inferenceStreamId,
      sessionId: 'session-a',
      runId: 'run-a',
      role: 'assistant',
      content: '可公开的回答',
      status: 'streaming',
      reasoning: { content: '分析中', status: 'streaming', source: 'provider' }
    });
    expect(presentInferenceStreamMessage({ ...stream, status: 'committed' }, run)).toBeNull();
    expect(presentInferenceStreamMessage(stream, undefined)).toBeNull();
  });

  it('presents the exact public Tool, capabilities, and resource scopes without the action token', () => {
    const decision: PublicDecisionProjectionV3 = {
      decisionId: 'decision-permission',
      runId: 'run-permission',
      sessionId: 'session-permission',
      version: 1,
      kind: 'permission',
      status: 'pending',
      presentation: {
        contractVersion: '1.0',
        kind: 'permission',
        headline: 'Permission required',
        summary: 'Tool workspace.write requests the listed capabilities before it can run.',
        toolName: 'workspace.write',
        capabilityIds: ['file.write', 'workspace.write'],
        scopeIds: ['resource.source', 'workspace.primary'],
        resourceSummary: 'The permission applies only to the listed resource scope identifiers.'
      },
      requestedAt: REQUESTED_AT,
      action: ACTION
    };

    const presented = presentPermissionDecision(decision);
    expect(presented).toMatchObject({
      toolName: 'workspace.write',
      scopeIds: ['resource.source', 'workspace.primary'],
      actionAvailable: true,
      permissionItems: [
        { capability: 'file.write' },
        { capability: 'workspace.write' }
      ]
    });
    expect(JSON.stringify(presented)).not.toContain('decision-action');
    expect(JSON.stringify(presented)).not.toContain(ACTION.actionToken);
  });

  it('presents every bounded Plan step and impact and enables only the exact Plan action', () => {
    const decision: PublicDecisionProjectionV3 = {
      decisionId: 'decision-plan',
      runId: 'run-plan',
      sessionId: 'session-plan',
      version: 1,
      kind: 'plan',
      status: 'pending',
      presentation: {
        contractVersion: '1.0',
        kind: 'plan',
        headline: 'Plan approval required',
        summary: 'Apply the reviewed refactoring in bounded stages.',
        impactSummary: 'The plan changes workspace files and runs verification.',
        approvalScope: 'continue_run_with_presented_plan',
        steps: [
          {
            title: 'Audit boundaries',
            summary: 'Read the relevant module contracts.',
            impact: 'read_only'
          },
          {
            title: 'Implement the slice',
            summary: 'Change only the reviewed modules.',
            impact: 'workspace_change'
          }
        ]
      },
      requestedAt: REQUESTED_AT,
      action: {
        contractVersion: '1.0',
        actionToken: ACTION.actionToken,
        choices: ['approve', 'reject']
      }
    };

    const presented = presentPlanDecision(decision);
    expect(presented).toMatchObject({
      summary: 'Apply the reviewed refactoring in bounded stages.',
      impactSummary: 'The plan changes workspace files and runs verification.',
      approvalScope: 'continue_run_with_presented_plan',
      actionAvailable: true
    });
    expect(presented?.steps).toHaveLength(2);
    expect(presented?.steps[1]).toMatchObject({
      title: 'Implement the slice',
      detail: 'Change only the reviewed modules. Impact: workspace_change.'
    });
    expect(presented?.plan).toBeNull();
    expect(JSON.stringify(presented)).not.toContain('decision-action');
  });

  it('fails closed for terminal decisions and kind-mismatched action choices', () => {
    const terminal: PublicDecisionProjectionV3 = {
      decisionId: 'decision-terminal',
      runId: 'run-terminal',
      sessionId: 'session-terminal',
      version: 2,
      kind: 'permission',
      status: 'rejected',
      presentation: {
        contractVersion: '1.0',
        kind: 'permission',
        headline: 'Permission rejected',
        summary: 'The requested operation was rejected.',
        toolName: 'workspace.write',
        capabilityIds: ['file.write'],
        scopeIds: [],
        resourceSummary: 'No resources will be changed.'
      },
      requestedAt: REQUESTED_AT,
      resolvedAt: '2032-01-01T00:00:01.000Z'
    };
    const wrongChoices: PublicDecisionProjectionV3 = {
      decisionId: 'decision-wrong-choices',
      runId: terminal.runId,
      sessionId: terminal.sessionId,
      version: 1,
      kind: 'permission',
      status: 'pending',
      presentation: terminal.presentation,
      requestedAt: terminal.requestedAt,
      action: {
        contractVersion: '1.0',
        actionToken: ACTION.actionToken,
        choices: ['approve', 'reject']
      }
    };

    expect(presentPermissionDecision(terminal)?.actionAvailable).toBe(false);
    expect(presentPermissionDecision(wrongChoices)?.actionAvailable).toBe(false);
  });

  it('presents a bounded user question and enables only the exact answer action', () => {
    const decision: PublicDecisionProjectionV3 = {
      decisionId: 'decision-user-question',
      runId: 'run-user-question',
      sessionId: 'session-user-question',
      version: 1,
      kind: 'user_question',
      status: 'pending',
      presentation: {
        contractVersion: '1.0',
        kind: 'user_question',
        headline: 'Agent needs your input',
        question: 'Which deployment target should be used?',
        options: [
          { optionId: 'local', label: 'Local only' },
          {
            optionId: 'remote',
            label: 'Remote host',
            description: 'Requires network access.'
          }
        ],
        allowsFreeText: true
      },
      requestedAt: REQUESTED_AT,
      action: {
        contractVersion: '1.0',
        actionToken: ACTION.actionToken,
        choices: ['answer']
      }
    };

    expect(presentUserQuestionDecision(decision)).toMatchObject({
      decisionId: decision.decisionId,
      prompt: 'Which deployment target should be used?',
      options: [
        { optionId: 'local', label: 'Local only' },
        {
          optionId: 'remote',
          label: 'Remote host',
          description: 'Requires network access.'
        }
      ],
      actionAvailable: true
    });
    expect(presentUserQuestionDecision({
      ...decision,
      action: { ...decision.action!, choices: ['approve'] }
    })?.actionAvailable).toBe(false);
  });
});
