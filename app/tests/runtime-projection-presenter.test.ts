import type { PublicDecisionProjectionV3 } from '@ariadne/protocol/public';
import { describe, expect, it } from 'vitest';

import {
  presentPermissionDecision,
  presentPlanDecision
} from '../src/renderer/src/core/runtime/runtime-projection-presenter';

const REQUESTED_AT = '2032-01-01T00:00:00.000Z';
const ACTION: NonNullable<PublicDecisionProjectionV3['action']> = {
  contractVersion: '1.0' as const,
  actionToken: `decision-action.v1:${'a'.repeat(64)}`,
  choices: ['allow_once', 'allow_run', 'deny']
};

describe('runtime projection Decision presenter', () => {
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
});
