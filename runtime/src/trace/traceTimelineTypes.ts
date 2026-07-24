export const RUN_TIMELINE_CATEGORIES = [
  "run",
  "model",
  "tool",
  "agent",
  "task",
  "routing",
  "fallback",
  "notification",
  "background",
  "subagent",
  "other",
] as const;

export type RunTimelineCategory = typeof RUN_TIMELINE_CATEGORIES[number];
