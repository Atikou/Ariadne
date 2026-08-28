import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentTimelineService } from "../src/agent/timeline/AgentTimelineService.js";
import {
  deleteWorkspaceSessionStorage,
  listWorkspaceSessionStorageRoots,
  workspaceSessionStorageRoot,
  workspaceStorageRoot,
} from "../src/agent/timeline/WorkspaceSessionStorage.js";
import {
  cleanupSessionArtifacts,
  deleteRunArtifacts,
} from "../src/lifecycle/SessionArtifactCleaner.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("application-owned workspace session storage", () => {
  it("groups session activity beneath the owning workspace and leaves projects untouched", () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-workspace-data-"));
    const firstWorkspace = mkdtempSync(path.join(os.tmpdir(), "ariadne-first-workspace-"));
    const secondWorkspace = mkdtempSync(path.join(os.tmpdir(), "ariadne-second-workspace-"));
    roots.push(dataRoot, firstWorkspace, secondWorkspace);

    const firstWorkspaceRoot = workspaceStorageRoot(dataRoot, firstWorkspace);
    const secondWorkspaceRoot = workspaceStorageRoot(dataRoot, secondWorkspace);
    expect(firstWorkspaceRoot).not.toBe(secondWorkspaceRoot);
    expect(path.dirname(firstWorkspaceRoot)).toBe(path.join(dataRoot, "workspaces"));
    expect(existsSync(firstWorkspaceRoot)).toBe(false);
    expect(existsSync(secondWorkspaceRoot)).toBe(false);

    writeCompletedRun(dataRoot, firstWorkspace, "session-first", "run-first");
    writeCompletedRun(dataRoot, firstWorkspace, "session-second", "run-second");
    writeCompletedRun(dataRoot, secondWorkspace, "session-third", "run-third");

    expect(existsSync(path.join(secondWorkspaceRoot, "sessions"))).toBe(true);
    expect(listWorkspaceSessionStorageRoots(dataRoot)).toHaveLength(3);

    const runRoot = path.join(
      workspaceSessionStorageRoot(dataRoot, firstWorkspace, "session-first"),
      "runs",
      "run-first",
    );
    expect(existsSync(path.join(runRoot, "run.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(runRoot, "manifest.json"), "utf8")))
      .toMatchObject({ sessionId: "session-first", projectPath: firstWorkspace });
    expect(existsSync(path.join(firstWorkspace, ".agent"))).toBe(false);
    expect(existsSync(path.join(secondWorkspace, ".agent"))).toBe(false);

    expect(deleteWorkspaceSessionStorage(dataRoot, "session-first")).toBe(true);
    expect(existsSync(workspaceSessionStorageRoot(dataRoot, firstWorkspace, "session-first"))).toBe(false);
    expect(listWorkspaceSessionStorageRoots(dataRoot)).toHaveLength(2);
    expect(existsSync(firstWorkspaceRoot)).toBe(true);

    expect(deleteWorkspaceSessionStorage(dataRoot, "session-second")).toBe(true);
    expect(existsSync(firstWorkspaceRoot)).toBe(false);
    expect(deleteWorkspaceSessionStorage(dataRoot, "session-third")).toBe(true);
    expect(existsSync(secondWorkspaceRoot)).toBe(false);
    expect(existsSync(path.join(dataRoot, "workspaces"))).toBe(false);
  });

  it("removes a session by identity without requiring the workspace registration", () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-delete-session-data-"));
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-delete-session-workspace-"));
    roots.push(dataRoot, workspaceRoot);
    const sessionId = "session-to-delete";
    const storageRoot = writeCompletedRun(dataRoot, workspaceRoot, sessionId, "temporary-run");

    cleanupSessionArtifacts({
      dataDir: dataRoot,
      sessionId,
      runIds: [],
      deleteTimeline: true,
      tombstone: false,
    });

    expect(existsSync(storageRoot)).toBe(false);
    expect(existsSync(workspaceStorageRoot(dataRoot, workspaceRoot))).toBe(false);
    expect(existsSync(path.join(workspaceRoot, ".agent"))).toBe(false);
  });

  it("removes the workspace folder after deleting its last run", () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-delete-run-data-"));
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "ariadne-delete-run-workspace-"));
    roots.push(dataRoot, workspaceRoot);
    const sessionId = "single-run-session";
    writeCompletedRun(dataRoot, workspaceRoot, sessionId, "single-run");

    deleteRunArtifacts({
      dataDir: dataRoot,
      sessionId,
      runId: "single-run",
    });

    expect(existsSync(workspaceStorageRoot(dataRoot, workspaceRoot))).toBe(false);
    expect(existsSync(path.join(dataRoot, "workspaces"))).toBe(false);
  });
});

function writeCompletedRun(
  dataRoot: string,
  workspaceRoot: string,
  sessionId: string,
  runId: string,
): string {
  const storageRoot = workspaceSessionStorageRoot(dataRoot, workspaceRoot, sessionId);
  const timeline = new AgentTimelineService({ projectRoot: workspaceRoot, storageRoot });
  timeline.createRun({ id: runId, sessionId, goal: "verify workspace-owned grouping" });
  timeline.completeRun("done");
  return storageRoot;
}
