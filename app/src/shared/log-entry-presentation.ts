export interface TraceLogText {
  category: string;
  message: string;
}

export function traceMessageForDisplay(entry: TraceLogText): string | null {
  const message = entry.message.trim();
  if (!message || message === entry.category.trim()) return null;
  return message;
}
