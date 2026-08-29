import { createHash } from 'node:crypto';
import type {
  AgentRunRecoveryPayloadReader,
  AgentRunRecoveryQuery,
  RecoverableAgentRun
} from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import { ProtectedAgentEffectResultReader } from '../src/control/resources/ProtectedAgentEffectResultReader.js';

describe('ProtectedAgentEffectResultReader', () => {
  it('retrieves one protected result by exact owner using UTF-8 byte cursors', async () => {
    const result = { text: '甲乙丙丁', nested: { ok: true } };
    const canonical = JSON.stringify(result);
    const recovery = activeRecovery();
    const listActiveRuns = vi.fn<AgentRunRecoveryQuery['listActiveRuns']>(async () => ({
      items: [recovery]
    }));
    const loadEffectResult = vi.fn<AgentRunRecoveryPayloadReader['loadEffectResult']>(
      async () => result
    );
    const reader = new ProtectedAgentEffectResultReader(
      { listActiveRuns },
      payloadReader(loadEffectResult)
    );

    const first = await reader.read({
      runId: 'run-spill-reader',
      workspaceId: 'workspace-spill-reader',
      effectId: 'effect-spill-reader',
      cursor: 0,
      maxBytes: 9
    });
    const second = await reader.read({
      runId: 'run-spill-reader',
      workspaceId: 'workspace-spill-reader',
      effectId: 'effect-spill-reader',
      cursor: first.nextCursor,
      maxBytes: 64 * 1024
    });

    expect(first.content).not.toContain('\uFFFD');
    expect(`${first.content}${second.content}`).toBe(canonical);
    expect(second).toMatchObject({
      effectId: 'effect-spill-reader',
      toolCallId: 'call-spill-reader',
      status: 'succeeded',
      totalBytes: Buffer.byteLength(canonical, 'utf8'),
      complete: true,
      digest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`
    });
    expect(loadEffectResult).toHaveBeenCalledTimes(2);
  });

  it('rejects cross-workspace and missing-owner reads before decoding payloads', async () => {
    const loadEffectResult = vi.fn<AgentRunRecoveryPayloadReader['loadEffectResult']>();
    const reader = new ProtectedAgentEffectResultReader(
      { listActiveRuns: async () => ({ items: [activeRecovery()] }) },
      payloadReader(loadEffectResult)
    );

    await expect(reader.read({
      runId: 'run-spill-reader',
      workspaceId: 'workspace-other',
      effectId: 'effect-spill-reader',
      cursor: 0,
      maxBytes: 10
    })).rejects.toThrow('agent_protected_effect_result_workspace_mismatch');
    await expect(reader.read({
      runId: 'run-other',
      workspaceId: 'workspace-spill-reader',
      effectId: 'effect-spill-reader',
      cursor: 0,
      maxBytes: 10
    })).rejects.toThrow('agent_protected_effect_result_run_unavailable');
    expect(loadEffectResult).not.toHaveBeenCalled();
  });
});

function payloadReader(
  loadEffectResult: AgentRunRecoveryPayloadReader['loadEffectResult']
): AgentRunRecoveryPayloadReader {
  return {
    loadCheckpoint: vi.fn(),
    loadEffectInput: vi.fn(),
    loadEffectResult,
    loadTurnInputPayload: vi.fn()
  };
}

function activeRecovery(): RecoverableAgentRun {
  return {
    ready: true,
    phase: 'resumable',
    run: {
      runId: 'run-spill-reader',
      binding: { workspace: { workspaceId: 'workspace-spill-reader' } },
      effects: [{
        effectId: 'effect-spill-reader',
        toolCallId: 'call-spill-reader',
        inputDigest: `sha256:${'a'.repeat(64)}`,
        state: { status: 'succeeded' }
      }]
    },
    effectPayloads: [{
      runId: 'run-spill-reader',
      effectId: 'effect-spill-reader',
      inputDigest: `sha256:${'a'.repeat(64)}`,
      inputCommandId: 'command-input-spill-reader',
      inputRunVersion: 1,
      hasResult: true,
      resultCommandId: 'command-result-spill-reader',
      resultRunVersion: 2,
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:01.000Z'
    }],
    turnInputPayloads: []
  } as unknown as RecoverableAgentRun;
}
