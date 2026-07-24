import {
  runtimeEventEnvelopeSchema,
  type RuntimeEvent,
  type RuntimeEventEnvelope,
  type RuntimeResult,
} from "@ariadne/protocol/public";

export function runtimeEnvelope(
  event: RuntimeEvent,
  cursor: number,
): RuntimeEventEnvelope {
  const metadata = metadataFor(event);
  return runtimeEventEnvelopeSchema.parse({
    eventId: `event-${cursor}`,
    cursor,
    schemaVersion: "2.0",
    aggregateType: metadata.aggregateType,
    aggregateId: metadata.aggregateId,
    aggregateVersion: metadata.aggregateVersion ?? cursor,
    occurredAt: "2026-07-22T00:00:00.000Z",
    event,
  });
}

export function emptyRuntimeSnapshot(revision = 0): Extract<RuntimeResult, { kind: "runtime.snapshot" }> {
  return {
    kind: "runtime.snapshot",
    snapshot: {
      revision,
      capturedAt: "2026-07-22T00:00:00.000Z",
      runs: [],
      permissions: [],
      planHandoffs: [],
      proposals: [],
    },
  };
}

function metadataFor(event: RuntimeEvent): {
  aggregateType: RuntimeEventEnvelope["aggregateType"];
  aggregateId: string;
  aggregateVersion?: number;
} {
  switch (event.kind) {
    case "runtime.status.changed":
      return { aggregateType: "runtime", aggregateId: "runtime" };
    case "companion.token.delta":
      return { aggregateType: "companion", aggregateId: event.messageId };
    case "companion.message.changed":
      return { aggregateType: "companion", aggregateId: event.message.messageId };
    case "agent.proposal.changed":
      return { aggregateType: "proposal", aggregateId: event.proposal.proposalId };
    case "run.changed":
      return {
        aggregateType: event.run.origin === "agent" ? "run" : "companion",
        aggregateId: event.run.runId,
        aggregateVersion: event.run.aggregateVersion,
      };
    case "run.activity":
      return { aggregateType: "trace", aggregateId: event.activity.activityId };
    case "permission.changed":
      return { aggregateType: "permission", aggregateId: event.request.requestId };
    case "planHandoff.changed":
      return { aggregateType: "plan_handoff", aggregateId: event.handoff.handoffId };
    case "trace.appended":
      return { aggregateType: "trace", aggregateId: event.entry.traceId };
  }
}
