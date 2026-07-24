export interface TraceLogText {
  category: string;
  message: string;
  metadata?: Record<string, unknown> | undefined;
}

export function traceMessageForDisplay(entry: TraceLogText): string | null {
  const message = entry.message.trim();
  if (!message || message === entry.category.trim()) return null;
  return message;
}

export function traceMetadataForDisplay(entry: TraceLogText): string | null {
  if (!entry.metadata || Object.keys(entry.metadata).length === 0) return null;
  try {
    return JSON.stringify(entry.metadata, null, 2);
  } catch {
    return '{"serializationError":true}';
  }
}
