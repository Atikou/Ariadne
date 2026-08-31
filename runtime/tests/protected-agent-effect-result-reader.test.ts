import { createHash } from 'node:crypto';
import type { AgentPinnedToolIdentity } from '@ariadne/agent-core';
import { describe, expect, it, vi } from 'vitest';

import type { AgentProtectedEffectResultAuthority } from '../src/control/ports/AgentToolExecution.js';
import { ProtectedAgentEffectResultReader } from '../src/control/resources/ProtectedAgentEffectResultReader.js';

const TOOL: AgentPinnedToolIdentity = {
  catalogId: 'catalog-reader',
  revision: 1,
  digest: `sha256:${'a'.repeat(64)}`,
  toolName: 'workspace.read_file',
  toolVersion: '2.0.0',
  providerId: 'ariadne.runtime',
  contractDigest: `sha256:${'b'.repeat(64)}`
};

describe('ProtectedAgentEffectResultReader', () => {
  it('retrieves one protected result by exact owner using UTF-8 byte cursors', async () => {
    const result = { text: '甲乙丙丁', nested: { ok: true } };
    const canonical = JSON.stringify(result);
    const load = vi.fn<AgentProtectedEffectResultAuthority['loadProtectedEffectResultAuthority']>(
      async () => authorityRecord(result)
    );
    const reader = new ProtectedAgentEffectResultReader({
      loadProtectedEffectResultAuthority: load
    });

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
      workspaceId: 'workspace-spill-reader',
      tool: TOOL,
      totalBytes: Buffer.byteLength(canonical, 'utf8'),
      complete: true,
      digest: `sha256:${createHash('sha256').update(canonical).digest('hex')}`
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('rejects cross-workspace and missing-owner reads', async () => {
    const load = vi.fn<AgentProtectedEffectResultAuthority['loadProtectedEffectResultAuthority']>(
      async (runId) => runId === 'run-spill-reader' ? authorityRecord({ ok: true }) : null
    );
    const reader = new ProtectedAgentEffectResultReader({
      loadProtectedEffectResultAuthority: load
    });

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
  });
});

function authorityRecord(result: Record<string, unknown>) {
  return {
    runId: 'run-spill-reader',
    workspaceId: 'workspace-spill-reader',
    effectId: 'effect-spill-reader',
    toolCallId: 'call-spill-reader',
    status: 'succeeded' as const,
    tool: TOOL,
    result
  };
}
