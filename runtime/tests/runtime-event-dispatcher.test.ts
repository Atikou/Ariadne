import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RuntimeEventEnvelope } from "@ariadne/protocol/public";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import { DomainEventJournal } from "../src/events/DomainEventJournal.js";
import { RuntimeEventDispatcher } from "../src/events/RuntimeEventDispatcher.js";
import { RunAggregateRepository } from "../src/run/RunAggregateRepository.js";

const temporaryRoots: string[] = [];

describe("RuntimeEventDispatcher", () => {
  let database: DatabaseManager;
  let journal: DomainEventJournal;
  let runs: RunAggregateRepository;

  beforeEach(() => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-event-outbox-"));
    temporaryRoots.push(root);
    database = new DatabaseManager(root);
    journal = new DomainEventJournal(database);
    runs = new RunAggregateRepository(database);
  });

  afterEach(() => {
    database.close();
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes Run facts from the durable outbox without consulting Trace", async () => {
    const delivered: RuntimeEventEnvelope[] = [];
    const dispatcher = new RuntimeEventDispatcher(journal, (event) => delivered.push(event), 10_000);
    dispatcher.start();

    const created = runs.execute({
      type: "run.create",
      runId: "run-1",
      kind: "agent",
      goal: "Inspect the workspace",
    });
    runs.execute({
      type: "run.start",
      runId: created.id,
      expectedAggregateVersion: created.aggregateVersion,
    });
    await dispatcher.flush();

    expect(delivered).toHaveLength(2);
    expect(delivered).toEqual([
      expect.objectContaining({
        cursor: 1,
        schemaVersion: "2.0",
        aggregateType: "run",
        aggregateId: "run-1",
        aggregateVersion: 1,
        event: expect.objectContaining({
          kind: "run.changed",
          run: expect.objectContaining({
            runId: "run-1",
            status: "queued",
            aggregateVersion: 1,
          }),
        }),
      }),
      expect.objectContaining({
        cursor: 2,
        aggregateVersion: 2,
        event: expect.objectContaining({
          kind: "run.changed",
          run: expect.objectContaining({ status: "running" }),
        }),
      }),
    ]);

    await dispatcher.flush();
    expect(delivered).toHaveLength(2);
    await dispatcher.stop();
  });

  it("uses a startup revision boundary and replays earlier events by persistent cursor", async () => {
    runs.execute({
      type: "run.create",
      runId: "before-start",
      kind: "agent",
      goal: "Existing run",
    });

    const delivered: RuntimeEventEnvelope[] = [];
    const dispatcher = new RuntimeEventDispatcher(journal, (event) => delivered.push(event), 10_000);
    dispatcher.start();
    await dispatcher.flush();
    expect(delivered).toEqual([]);

    const replay = dispatcher.replay(0, 100);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ cursor: 1, aggregateId: "before-start" });

    runs.execute({
      type: "run.create",
      runId: "after-start",
      kind: "agent",
      goal: "New run",
    });
    await dispatcher.flush();
    expect(delivered).toEqual([
      expect.objectContaining({ cursor: 2, aggregateId: "after-start" }),
    ]);
    await dispatcher.stop();
  });

  it("persists non-Run events and advances consumer cursors monotonically", () => {
    journal.append({
      aggregateType: "companion",
      aggregateId: "message-1",
      event: {
        kind: "companion.message.changed",
        message: {
          messageId: "message-1",
          sessionId: "session-1",
          role: "assistant",
          content: "Persisted response",
          status: "completed",
          createdAt: "2026-07-22T00:00:00.000Z",
        },
      },
    });
    journal.append({
      aggregateType: "companion",
      aggregateId: "message-1",
      event: {
        kind: "companion.message.changed",
        message: {
          messageId: "message-1",
          sessionId: "session-1",
          role: "assistant",
          content: "Updated response",
          status: "completed",
          createdAt: "2026-07-22T00:00:00.000Z",
        },
      },
    });

    expect(journal.replay({ afterCursor: 0, limit: 100 })).toEqual([
      expect.objectContaining({ cursor: 1, aggregateVersion: 1 }),
      expect.objectContaining({ cursor: 2, aggregateVersion: 2 }),
    ]);
    journal.acknowledge("renderer", 2);
    journal.acknowledge("renderer", 1);
    expect(journal.consumerCursor("renderer")).toBe(2);
  });
});
