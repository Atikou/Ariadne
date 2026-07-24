import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RuntimeEvent } from '@ariadne/protocol/public';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeEventBridge } from '../src/application/RuntimeEventBridge.js';
import { projectMessage, projectPermissionRequest, projectTraceEvent } from '../src/application/publicProjection.js';
import type { AppContext } from '../src/app/createAppContext.js';
import { ACTIVE_SEGMENT_PATH, TraceIndexStore } from '../src/trace/TraceIndexStore.js';
import { TraceLogger } from '../src/trace/TraceLogger.js';
import { resolveTracePaths } from '../src/trace/tracePaths.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RuntimeEventBridge', () => {
  it('keeps a structural trace category out of the message field when no public text exists', () => {
    expect(projectTraceEvent({
      type: 'assistant_agent_proposal_settled',
      status: 'failed'
    }, 'trace-1')).toMatchObject({
      traceId: 'trace-1',
      level: 'error',
      category: 'assistant_agent_proposal_settled',
      message: ''
    });
  });

  it('projects persisted protocol interruptions into a visible retryable message error', () => {
    expect(projectMessage({
      id: 'assistant-message-1',
      sessionId: 'session-1',
      role: 'assistant',
      content: '已保留的部分回复',
      status: 'interrupted',
      trusted: true,
      memoryEligible: false,
      storageRoot: 'E:\\Project\\Ariadne',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:01.000Z',
      metadata: { errorCode: 'COMPANION_TURN_PROTOCOL_ERROR' }
    })).toMatchObject({
      status: 'interrupted',
      content: '已保留的部分回复',
      error: {
        code: 'COMPANION_TURN_PROTOCOL_ERROR',
        retryable: true
      }
    });
  });

  it('publishes new permission, plan, trace, activity, and proposal state without changing Agent core', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-event-bridge-'));
    temporaryRoots.push(root);
    const tracesDir = path.join(root, 'traces');
    const layout = resolveTracePaths(tracesDir);
    const trace = new TraceLogger(layout.activeFile, { tracesDir, redact: true });
    const events: RuntimeEvent[] = [];
    const permissions: Array<Record<string, unknown>> = [];
    const plans: Array<Record<string, unknown>> = [];
    const proposal = sourceProposal('proposal-1', 'run-1', 'waiting_permission');
    const app = {
      paths: { traceFile: layout.activeFile },
      traceCatalog: { tracesDir },
      permissionRequestStore: { listPending: () => permissions },
      planHandoffStore: { listPending: () => plans },
      agentHandoffCoordinator: { get: (id: string) => id === proposal.id ? proposal : null },
      runs: {
        get: (id: string) => id === 'run-1' ? {
          id,
          kind: 'agent',
          sessionId: 'agent-session-1',
          goal: '检查项目',
          status: 'waiting_confirmation',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        } : null
      }
    } as unknown as AppContext;
    const bridge = new RuntimeEventBridge(
      app,
      (event) => events.push(event),
      (request) => projectPermissionRequest(request, {
        workspaceId: 'primary',
        workspaceLabel: 'Primary workspace'
      }),
      10_000
    );
    await bridge.start();

    permissions.push(permissionRequest());
    plans.push(planHandoff());
    trace.write({
      type: 'tool_audit',
      tool: 'read_file',
      status: 'start',
      toolCallId: 'tool-1',
      runId: 'run-1'
    });
    trace.write({
      type: 'assistant_agent_proposal_settled',
      proposalId: proposal.id,
      runId: 'run-1',
      status: 'waiting_permission'
    });
    await bridge.flush();
    await bridge.emitProposalForRun('run-1');

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'permission.changed',
        request: expect.objectContaining({
          requestId: 'permission-1',
          workspaceId: 'primary',
          workspaceLabel: 'Primary workspace'
        })
      }),
      expect.objectContaining({ kind: 'planHandoff.changed', handoff: expect.objectContaining({ handoffId: 'plan-1' }) }),
      expect.objectContaining({ kind: 'trace.appended', entry: expect.objectContaining({ runId: 'run-1' }) }),
      expect.objectContaining({ kind: 'run.activity', activity: expect.objectContaining({ activityId: 'tool:tool-1', status: 'running' }) }),
      expect.objectContaining({ kind: 'run.changed', run: expect.objectContaining({ runId: 'run-1', origin: 'agent', status: 'waiting_permission' }) }),
      expect.objectContaining({ kind: 'agent.proposal.changed', proposal: expect.objectContaining({ proposalId: proposal.id }) })
    ]));
    await bridge.stop();
    trace.close();
  });

  it('bounds trace deduplication memory while polling a long-running trace', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-event-bridge-bounded-'));
    temporaryRoots.push(root);
    const tracesDir = path.join(root, 'traces');
    const layout = resolveTracePaths(tracesDir);
    const trace = new TraceLogger(layout.activeFile, { tracesDir, redact: true });
    const app = {
      paths: { traceFile: layout.activeFile },
      traceCatalog: { tracesDir },
      permissionRequestStore: { listPending: () => [] },
      planHandoffStore: { listPending: () => [] },
      agentHandoffCoordinator: { get: () => null },
      runs: {
        get: (id: string) => ({
          id,
          kind: 'agent',
          goal: `Run ${id}`,
          status: 'completed',
          createdAt: '2026-07-22T00:00:00.000Z',
          updatedAt: '2026-07-22T00:00:01.000Z'
        })
      }
    } as unknown as AppContext;
    const bridge = new RuntimeEventBridge(
      app,
      () => undefined,
      (request) => projectPermissionRequest(request),
      10_000
    );
    await bridge.start();

    for (let batch = 0; batch < 4; batch += 1) {
      for (let index = 0; index < 1_000; index += 1) {
        trace.write({
          type: 'tool_audit',
          tool: 'read_file',
          status: 'start',
          toolCallId: `tool-${batch}-${index}`,
          runId: `run-${batch}-${index}`,
          proposalId: `proposal-${batch}-${index}`
        });
      }
      await bridge.flush();
    }

    const tracked = bridge as unknown as {
      seenTraceIds: { size: number };
      proposalIdByRunId: { size: number };
      runFingerprints: { size: number };
    };
    expect(tracked.seenTraceIds.size).toBeLessThanOrEqual(2_000);
    expect(tracked.proposalIdByRunId.size).toBeLessThanOrEqual(2_000);
    expect(tracked.runFingerprints.size).toBeLessThanOrEqual(2_000);
    await bridge.stop();
    trace.close();
  });

  it('delivers an indexed trace burst larger than the legacy polling window without loss', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-event-bridge-indexed-'));
    temporaryRoots.push(root);
    const tracesDir = path.join(root, 'traces');
    const layout = resolveTracePaths(tracesDir);
    const traceIndex = new TraceIndexStore(layout.indexDbPath);
    const trace = new TraceLogger(layout.activeFile, { tracesDir, redact: true, index: traceIndex });
    const events: RuntimeEvent[] = [];
    const app = {
      paths: { traceFile: layout.activeFile },
      traceCatalog: { tracesDir, index: traceIndex },
      permissionRequestStore: { listPending: () => [] },
      planHandoffStore: { listPending: () => [] },
      agentHandoffCoordinator: { get: () => null },
      runs: { get: () => null }
    } as unknown as AppContext;
    const bridge = new RuntimeEventBridge(
      app,
      (event) => events.push(event),
      (request) => projectPermissionRequest(request),
      10_000
    );

    try {
      await bridge.start();
      const burstSize = 2_101;
      for (let index = 0; index < burstSize; index += 1) {
        trace.write({
          type: 'tool_audit',
          tool: 'read_file',
          status: 'start',
          toolCallId: `burst-tool-${index}`,
          runId: 'burst-run'
        });
      }

      await bridge.flush();

      expect(events.filter((event) => event.kind === 'trace.appended')).toHaveLength(burstSize);
      expect(events.filter((event) => event.kind === 'run.activity')).toHaveLength(burstSize);
    } finally {
      await bridge.stop();
      trace.close();
      traceIndex.close();
    }
  });

  it('retries an indexed trace batch without advancing the cursor when its segment is temporarily unavailable', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-event-bridge-index-retry-'));
    temporaryRoots.push(root);
    const tracesDir = path.join(root, 'traces');
    const layout = resolveTracePaths(tracesDir);
    const traceIndex = new TraceIndexStore(layout.indexDbPath);
    const events: RuntimeEvent[] = [];
    const app = {
      paths: { traceFile: layout.activeFile },
      traceCatalog: { tracesDir, index: traceIndex },
      permissionRequestStore: { listPending: () => [] },
      planHandoffStore: { listPending: () => [] },
      agentHandoffCoordinator: { get: () => null },
      runs: { get: () => null }
    } as unknown as AppContext;
    const bridge = new RuntimeEventBridge(
      app,
      (event) => events.push(event),
      (request) => projectPermissionRequest(request),
      10_000
    );

    try {
      await bridge.start();
      const eventId = 'indexed-retry-event';
      const timestamp = Date.now();
      const relocatedSegment = 'segments/indexed-retry.jsonl';
      const relocatedPath = path.join(tracesDir, relocatedSegment);
      mkdirSync(path.dirname(relocatedPath), { recursive: true });
      writeFileSync(relocatedPath, `${JSON.stringify({
        eventId,
        time: new Date(timestamp).toISOString(),
        type: 'tool_audit',
        tool: 'read_file',
        status: 'start',
        toolCallId: 'indexed-retry-tool',
        runId: 'indexed-retry-run'
      })}\n`, 'utf8');
      traceIndex.insert({
        eventId,
        ts: timestamp,
        eventType: 'tool_audit',
        runId: 'indexed-retry-run',
        status: 'start',
        segmentPath: ACTIVE_SEGMENT_PATH,
        redacted: true
      });

      await expect(bridge.flush()).rejects.toThrow('indexed_trace_batch_unavailable:1');
      expect(events).toHaveLength(0);

      traceIndex.reassignSegment(ACTIVE_SEGMENT_PATH, relocatedSegment);
      await bridge.flush();

      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'trace.appended',
          entry: expect.objectContaining({ traceId: eventId, runId: 'indexed-retry-run' })
        }),
        expect.objectContaining({
          kind: 'run.activity',
          activity: expect.objectContaining({ activityId: 'tool:indexed-retry-tool' })
        })
      ]));
      expect(events).toHaveLength(2);

      await bridge.flush();
      expect(events).toHaveLength(2);
    } finally {
      await bridge.stop();
      traceIndex.close();
    }
  });

  it('serializes concurrent starts and cannot re-arm polling after stop begins', async () => {
    const bridge = new RuntimeEventBridge(
      {} as AppContext,
      () => undefined,
      (request) => projectPermissionRequest(request),
      10_000
    );
    let releasePrime!: () => void;
    const prime = vi.fn(() => new Promise<void>((resolve) => { releasePrime = resolve; }));
    const internals = bridge as unknown as {
      prime(): Promise<void>;
      timer?: NodeJS.Timeout;
      running: boolean;
    };
    internals.prime = prime;

    const firstStart = bridge.start();
    const secondStart = bridge.start();
    const stopped = bridge.stop();
    releasePrime();
    await Promise.all([firstStart, secondStart, stopped]);

    expect(prime).toHaveBeenCalledTimes(1);
    expect(internals.running).toBe(false);
    expect(internals.timer).toBeUndefined();
  });

  it('waits for an active flush to settle before stop completes', async () => {
    const bridge = new RuntimeEventBridge(
      {} as AppContext,
      () => undefined,
      (request) => projectPermissionRequest(request),
      10_000
    );
    let releaseFlush!: () => void;
    const internals = bridge as unknown as { flushNow(): Promise<void> };
    internals.flushNow = () => new Promise<void>((resolve) => { releaseFlush = resolve; });
    const flush = bridge.flush();
    let stopped = false;
    const stop = bridge.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseFlush();
    await Promise.all([flush, stop]);
    expect(stopped).toBe(true);
  });
});

function permissionRequest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'permission-1',
    runId: 'run-1',
    sessionId: 'session-1',
    projectId: 'primary',
    status: 'pending',
    title: '读取配置',
    summary: '需要读取工作区配置',
    requiredPermissions: [{
      id: 'permission-item-1',
      type: 'read_file',
      target: 'E:\\Project\\Ariadne\\package.json',
      reason: '读取项目配置',
      riskTier: 'low',
      rootPath: 'E:\\Project\\Ariadne'
    }],
    createdAt: new Date().toISOString(),
    approvalVersion: 'approval-1'
  };
}

function planHandoff(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'plan-1',
    runId: 'run-1',
    sessionId: 'session-1',
    status: 'pending',
    message: '确认执行计划',
    planMarkdown: '- 检查文件\n- 汇总结果',
    createdAt: new Date().toISOString()
  };
}

function sourceProposal(id: string, runId: string, status: string): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    sourceTurnId: 'turn-1',
    companionSessionId: 'session-1',
    agentSessionId: 'agent-session-1',
    reason: '需要读取项目',
    originalRequest: '检查项目',
    interpretedTask: '检查项目文件',
    requestedCapabilities: ['file-read'],
    requestedScope: ['E:\\Project\\Ariadne'],
    risk: 'read-only',
    workspaceKey: 'primary',
    status,
    createdAt: now,
    updatedAt: now,
    respondedAt: now,
    grantId: 'grant-1',
    runId,
    outcome: { status: 'waiting_permission', permissionRequestId: 'permission-1' }
  };
}
