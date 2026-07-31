import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentTimelineService } from '../src/agent/timeline/AgentTimelineService.js';
import {
  deleteSessionAgentStorage,
  sessionAgentStorageRoot
} from '../src/agent/timeline/SessionAgentStorage.js';
import { cleanupSessionArtifacts } from '../src/lifecycle/SessionArtifactCleaner.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('session-owned .agent storage', () => {
  it('writes activity artifacts under the session data root and leaves the workspace untouched', () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-session-agent-data-'));
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-session-agent-workspace-'));
    roots.push(dataRoot, workspaceRoot);
    const sessionId = 'session-owned-activity';
    const storageRoot = sessionAgentStorageRoot(dataRoot, sessionId);
    const timeline = new AgentTimelineService({
      projectRoot: workspaceRoot,
      storageRoot
    });

    timeline.createRun({
      id: 'session-run',
      sessionId,
      goal: 'verify storage ownership'
    });
    timeline.completeRun('done');

    const runRoot = path.join(storageRoot, '.agent', 'runs', 'session-run');
    expect(existsSync(path.join(runRoot, 'run.json'))).toBe(true);
    expect(existsSync(path.join(workspaceRoot, '.agent'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(runRoot, 'manifest.json'), 'utf8')))
      .toMatchObject({ sessionId, projectPath: workspaceRoot });

    expect(deleteSessionAgentStorage(dataRoot, sessionId)).toBe(true);
    expect(existsSync(storageRoot)).toBe(false);
  });

  it('removes the session owner even when the session has no recorded runs', () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-empty-session-agent-data-'));
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), 'ariadne-empty-session-agent-workspace-'));
    roots.push(dataRoot, workspaceRoot);
    const sessionId = 'empty-session-owner';
    const storageRoot = sessionAgentStorageRoot(dataRoot, sessionId);
    const timeline = new AgentTimelineService({ projectRoot: workspaceRoot, storageRoot });
    timeline.createRun({ id: 'temporary-run', sessionId, goal: 'create owner root' });
    timeline.completeRun('done');

    cleanupSessionArtifacts({
      dataDir: dataRoot,
      workspaceRoot,
      sessionId,
      runIds: [],
      deleteTimeline: true,
      tombstone: false
    });

    expect(existsSync(storageRoot)).toBe(false);
    expect(existsSync(path.join(workspaceRoot, '.agent'))).toBe(false);
  });
});
