import {
  runtimeEventEnvelopeSchema,
  type RuntimeEvent,
  type RuntimeEventEnvelope,
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

function metadataFor(event: RuntimeEvent): {
  aggregateType: RuntimeEventEnvelope["aggregateType"];
  aggregateId: string;
  aggregateVersion?: number;
} {
  switch (event.kind) {
    case "inference.chunk.observed":
      return {
        aggregateType: "inference_stream",
        aggregateId: `${event.runId}:${event.turnId}:${event.attemptId}`,
        aggregateVersion: event.sequence,
      };
    case "inference.stream.terminated":
      return {
        aggregateType: "inference_stream",
        aggregateId: `${event.runId}:${event.turnId}:${event.attemptId}`,
        aggregateVersion: event.finalSequence + 1,
      };
    case "projection.changed":
      return { aggregateType: "projection", aggregateId: event.feature };
  }
}
