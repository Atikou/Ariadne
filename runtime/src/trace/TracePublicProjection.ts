import { redactValue } from "../util/redact.js";
import {
  createPublicPathProjector,
  type PublicPathRoot,
} from "../util/publicPathProjection.js";
import {
  TraceJsonValueSchema,
  TracePublicEventSchema,
  type TracePublicEvent,
} from "./TraceContracts.js";

export type TracePublicPathRoot = PublicPathRoot;

export function projectTraceEventsForPublic(
  events: readonly unknown[],
  roots: readonly TracePublicPathRoot[],
): TracePublicEvent[] {
  const projectPaths = createPublicPathProjector(roots);
  const projected: TracePublicEvent[] = [];
  for (const event of events) {
    const redacted = TraceJsonValueSchema.safeParse(redactValue(event));
    if (!redacted.success) continue;
    const sanitized = projectPaths(redacted.data);
    const parsed = TracePublicEventSchema.safeParse(sanitized);
    if (parsed.success) projected.push(parsed.data);
  }
  return projected;
}
