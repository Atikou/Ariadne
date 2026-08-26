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

  it("replays an event after process loss before live delivery acknowledgement", async () => {
    const first = new RuntimeEventDispatcher(
      journal,
      () => {
        throw new Error("injected_sink_crash");
      },
      10_000,
    );
    first.start();
    journal.append({
      aggregateType: "companion",
      aggregateId: "message-crash",
      event: {
        kind: "companion.message.changed",
        message: {
          messageId: "message-crash",
          sessionId: "session-crash",
          role: "assistant",
          content: "Persisted before delivery",
          status: "completed",
          createdAt: "2026-07-31T00:00:00.000Z",
        },
      },
    });
    await expect(first.flush()).rejects.toThrow("injected_sink_crash");
    await first.stop();
    expect(journal.consumerCursor("runtime-live-projection")).toBe(0);

    const delivered: RuntimeEventEnvelope[] = [];
    const restarted = new RuntimeEventDispatcher(
      journal,
      (event) => delivered.push(event),
      10_000,
    );
    restarted.start();
    await restarted.flush();

    expect(delivered).toEqual([
      expect.objectContaining({
        eventId: expect.any(String),
        aggregateId: "message-crash",
        cursor: 1,
      }),
    ]);
    expect(journal.consumerCursor("runtime-live-projection")).toBe(1);
    await restarted.stop();
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

  it("idempotently appends an externally identified public Run projection", () => {
    const input = {
      eventId: "agent-outbox:run-control-1:3:1",
      aggregateType: "run" as const,
      aggregateId: "run-control-1",
      aggregateVersion: 3,
      occurredAt: "2026-07-31T00:00:00.000Z",
      correlationId: "command-control-1",
      event: {
        kind: "run.changed" as const,
        run: {
          runId: "run-control-1",
          sessionId: "session-control-1",
          sourceMessageId: "message-control-1",
          origin: "agent" as const,
          title: "Inspect the workspace",
          status: "running" as const,
          userFacingLabel: "Running",
          aggregateVersion: 3,
          checkpointStage: "turn_started",
          recoveryStatus: "none" as const,
          timing: { activeDurationMs: 0 },
          startedAt: "2026-07-31T00:00:00.000Z",
        },
      },
    };

    const first = journal.append(input);
    const replay = journal.append(input);

    expect(replay).toEqual(first);
    expect(journal.replay({ afterCursor: 0, limit: 10 })).toHaveLength(1);
    expect(new RuntimeEventDispatcher(journal, () => undefined).replay(0, 10))
      .toEqual([expect.objectContaining({
        eventId: input.eventId,
        aggregateType: "run",
        aggregateId: input.aggregateId,
        aggregateVersion: 3,
        event: input.event,
      })]);
  });

  it("rejects event-id and aggregate-version projection drift", () => {
    const base = {
      eventId: "agent-outbox:run-control-2:1:1",
      aggregateType: "run" as const,
      aggregateId: "run-control-2",
      aggregateVersion: 1,
      occurredAt: "2026-07-31T00:00:00.000Z",
      event: {
        kind: "run.changed" as const,
        run: {
          runId: "run-control-2",
          origin: "agent" as const,
          title: "Inspect",
          status: "queued" as const,
          userFacingLabel: "Queued",
          aggregateVersion: 1,
          checkpointStage: "queued",
          recoveryStatus: "none" as const,
          timing: { activeDurationMs: 0 },
        },
      },
    };
    journal.append(base);

    expect(() => journal.append({
      ...base,
      event: {
        ...base.event,
        run: { ...base.event.run, userFacingLabel: "Drifted" },
      },
    })).toThrow(`domain_event_id_conflict:${base.eventId}`);
    expect(() => journal.append({
      ...base,
      eventId: "agent-outbox:run-control-2:1:other",
    })).toThrow("domain_event_aggregate_version_conflict:run:run-control-2:1");
    expect(journal.replay({ afterCursor: 0, limit: 10 })).toHaveLength(1);
  });

  it("rejects a Run envelope whose aggregate identity differs from its payload", () => {
    const event = {
      kind: "run.changed" as const,
      run: {
        runId: "run-payload",
        origin: "agent" as const,
        title: "Inspect",
        status: "running" as const,
        userFacingLabel: "Running",
        aggregateVersion: 2,
        checkpointStage: "turn_started",
        recoveryStatus: "none" as const,
        timing: { activeDurationMs: 0 },
      },
    };

    expect(() => journal.append({
      aggregateType: "run",
      aggregateId: "run-envelope",
      aggregateVersion: 2,
      event,
    })).toThrow("domain_event_run_identity_mismatch");
    expect(() => journal.append({
      aggregateType: "run",
      aggregateId: "run-payload",
      aggregateVersion: 3,
      event,
    })).toThrow("domain_event_run_identity_mismatch");
    expect(() => journal.append({
      aggregateType: "companion",
      aggregateId: "run-payload",
      aggregateVersion: 2,
      event,
    })).toThrow("domain_event_run_identity_mismatch");
    expect(journal.replay({ afterCursor: 0, limit: 10 })).toEqual([]);
  });

  it("rejects non-public envelope metadata before it can poison the live cursor", () => {
    const event = {
      kind: "companion.message.changed" as const,
      message: {
        messageId: "message-safe",
        sessionId: "session-safe",
        role: "assistant" as const,
        content: "Safe payload",
        status: "completed" as const,
        createdAt: "2026-07-31T00:00:00.000Z",
      },
    };

    expect(() => journal.append({
      eventId: "e".repeat(257),
      aggregateType: "companion",
      aggregateId: "message-safe",
      aggregateVersion: 1,
      occurredAt: "2026-07-31T00:00:00.000Z",
      event,
    })).toThrow("domain_event_id_invalid");
    expect(() => journal.append({
      eventId: "event-safe",
      aggregateType: "companion",
      aggregateId: " message-safe ",
      aggregateVersion: 1,
      occurredAt: "2026-07-31T00:00:00.000Z",
      event,
    })).toThrow("domain_event_aggregate_id_invalid");
    expect(() => journal.append({
      eventId: "event-safe",
      aggregateType: "companion",
      aggregateId: "message-safe",
      aggregateVersion: 1,
      // Date.parse accepts this RFC value, but the public protocol requires
      // canonical ISO 8601 with an explicit offset.
      occurredAt: "Wed, 31 Jul 2026 00:00:00 GMT",
      event,
    })).toThrow();
    expect(() => journal.append({
      eventId: "event-safe",
      aggregateType: "companion",
      aggregateId: "message-safe",
      aggregateVersion: 1,
      occurredAt: "2026-07-31T00:00:00.000Z",
      correlationId: " correlation-safe ",
      event,
    })).toThrow("domain_event_correlation_id_invalid");
    expect(() => journal.append({
      eventId: "event-safe",
      aggregateType: "companion",
      aggregateId: "message-safe",
      aggregateVersion: 1,
      occurredAt: "2026-07-31T00:00:00.000Z",
      causationId: "c".repeat(257),
      event,
    })).toThrow("domain_event_causation_id_invalid");
    expect(journal.replay({ afterCursor: 0, limit: 10 })).toEqual([]);
  });
});
