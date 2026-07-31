import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PausedRunStore,
  type PausedRunSnapshot,
} from "../src/agent/PausedRunStore.js";
import { DatabaseManager } from "../src/context/DatabaseManager.js";

const roots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PausedRunStore resume ownership", () => {
  it("allows one claimant and never deletes a replacement pause", () => {
    const store = new PausedRunStore();
    const original = snapshot("run-1", "first");
    store.save(original);

    expect(store.claim(original.runId)).toEqual(original);
    expect(store.claim(original.runId)).toBeNull();
    expect(store.get(original.runId)).toEqual(original);

    const replacement = snapshot("run-1", "second");
    store.save(replacement);
    expect(store.completeClaim(original)).toBe(false);
    expect(store.get(original.runId)).toEqual(replacement);
    expect(store.claim(original.runId)).toEqual(replacement);
    expect(store.releaseClaim(replacement)).toBe(true);
    expect(store.claim(original.runId)).toEqual(replacement);
  });

  it("recovers an interrupted database claim after process restart", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-paused-claim-"));
    roots.push(root);
    const firstDb = new DatabaseManager(root);
    const firstStore = new PausedRunStore(firstDb.connection);
    const original = snapshot("run-db", "durable");
    firstStore.save(original);
    expect(firstStore.claim(original.runId)).toEqual(original);
    firstDb.close();

    const secondDb = new DatabaseManager(root);
    databases.push(secondDb);
    const secondStore = new PausedRunStore(secondDb.connection);
    expect(secondStore.claim(original.runId)).toBeNull();
    expect(secondStore.get(original.runId)).toEqual(original);
    expect(secondStore.recoverInterruptedClaims()).toBe(1);
    expect(secondStore.claim(original.runId)).toEqual(original);
    expect(secondStore.completeClaim(original)).toBe(true);
    expect(secondStore.get(original.runId)).toBeNull();
  });
});

function snapshot(runId: string, goal: string): PausedRunSnapshot {
  return {
    runId,
    goal,
    messages: [{ role: "user", content: goal }],
    steps: [],
    modelTurns: 1,
    mode: "implement",
    permissionPolicy: "confirmBeforeRun",
    execution: {
      engineKind: "react_loop",
      schemaVersion: 1,
    },
    createdAt: new Date().toISOString(),
  };
}
