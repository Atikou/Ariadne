export type TraceLevel = "debug" | "info" | "warning" | "error";

/**
 * Trace payload contract shared by writers and readers.
 *
 * Keeping this contract independent prevents storage discovery/migration code
 * from depending on the concrete logger implementation.
 */
export interface TraceEvent {
  type: string;
  level?: TraceLevel;
  category?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}
