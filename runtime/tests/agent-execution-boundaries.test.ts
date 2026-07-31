import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AIIntentClassifier } from '../src/agent/routing/AIIntentClassifier.js';
import { EntryIntentRouter } from '../src/agent/routing/EntryIntentRouter.js';
import { AgentTimelineService } from '../src/agent/timeline/AgentTimelineService.js';
import { AgentRunRegistry } from '../src/orchestrator/AgentRunRegistry.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Agent execution boundaries', () => {
  it('does not call the intent model when the caller forces a valid mode', async () => {
    const classify = vi.fn(async () => JSON.stringify({
      intent: 'answer',
      confidence: 1,
      isContinuation: false,
    }));
    const router = new EntryIntentRouter(undefined, new AIIntentClassifier(classify));

    const decision = await router.resolveAsync({
      requestedMode: 'implement',
      forceRequestedMode: true,
      message: 'Create the requested project.',
    });

    expect(classify).not.toHaveBeenCalled();
    expect(decision).toMatchObject({
      mode: 'implement',
      modeSource: 'explicit',
      source: 'explicit_mode',
    });
  });

  it('never lets a resumed worker replace the worker that is still pausing', async () => {
    const registry = new AgentRunRegistry();
    const first = registry.register('run-1');

    expect(() => registry.register('run-1')).toThrow('run_execution_already_active:run-1');

    let idle = false;
    const waiting = registry.waitUntilIdle('run-1').then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    registry.unregister('run-1');
    await waiting;
    expect(idle).toBe(true);
    expect(first.signal.aborted).toBe(false);
    expect(registry.register('run-1')).toBeInstanceOf(AbortController);
  });

  it('resumes the same activity timeline without replacing its creation time or steps', () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-timeline-resume-'));
    temporaryRoots.push(workspaceRoot);
    const originalEvents: string[] = [];
    const initial = new AgentTimelineService({
      projectRoot: workspaceRoot,
      storageRoot: workspaceRoot,
      onEvent: (event) => originalEvents.push(event.type),
    });
    const created = initial.createRun({
      id: 'run-1',
      goal: 'Create a file',
      sessionId: 'session-1',
    });
    const step = initial.startStep({
      runId: created.id,
      type: 'tool',
      title: 'Inspect workspace',
    });
    initial.completeStep(step.id, 'done');
    initial.pauseRun('Waiting for permission');

    const resumedEvents: string[] = [];
    const resumedTimeline = new AgentTimelineService({
      projectRoot: workspaceRoot,
      storageRoot: workspaceRoot,
      onEvent: (event) => resumedEvents.push(event.type),
    });
    const resumed = resumedTimeline.resumeRun({
      id: created.id,
      goal: created.goal,
      sessionId: 'session-1',
    });

    expect(originalEvents).toContain('run_paused');
    expect(resumedEvents).toEqual(['run_resumed']);
    expect(resumed.createdAt).toBe(created.createdAt);
    expect(resumed.steps).toHaveLength(2);
    expect(resumed.steps[0]).toMatchObject({ id: step.id, status: 'success' });
    expect(resumed.status).toBe('running');
  });
});
