export type LogCategory = 'system' | 'agent' | 'tool' | 'network' | 'model' | 'security';
export type LogViewFilter = 'important' | LogCategory;
export type LogLevelFilter = 'all' | 'warning' | 'error';

export interface TraceLogText {
  category: string;
  message: string;
  level?: 'debug' | 'info' | 'warning' | 'error';
  occurredAt?: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface CoalescedTraceLog<T extends TraceLogText> {
  entry: T;
  repeats: number;
}

const IMPORTANT_INFO_CATEGORIES = [
  /^run_(?:start|resume|end)$/u,
  /proposal_(?:created|settled)$/u,
  /handoff_recovery/u,
  /(?:^|_)recovery(?:_|$)/u,
  /permission_(?:requested|approved|denied|settled)/u,
  /runtime_(?:ready|started|stopped)/u
] as const;

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

export function traceLogCategory(entry: Pick<TraceLogText, 'category'>): LogCategory {
  const category = entry.category.toLowerCase();
  if (/(?:permission|approval|grant|policy|sandbox|path_access|access_decision|security)/u.test(category)) {
    return 'security';
  }
  if (/(?:network|http|fetch|sse|socket|dns|browser)/u.test(category)) return 'network';
  if (/(?:model|provider|routing|inference|token)/u.test(category)) return 'model';
  if (/(?:tool|shell|mcp|file[._-])/u.test(category)) return 'tool';
  if (/(?:agent|run[._-]|plan|task|workflow|companion|assistant|subagent)/u.test(category)) return 'agent';
  return 'system';
}

export function traceLogCategoryLabel(category: LogCategory): string {
  return {
    system: '系统',
    agent: 'Agent',
    tool: '工具',
    network: '网络',
    model: '模型',
    security: '安全'
  }[category];
}

export function traceMatchesView(entry: TraceLogText, filter: LogViewFilter): boolean {
  if (entry.level === 'debug') return false;
  if (filter !== 'important') return traceLogCategory(entry) === filter;
  if (entry.level === 'warning' || entry.level === 'error') return true;
  const category = entry.category.toLowerCase();
  return IMPORTANT_INFO_CATEGORIES.some((pattern) => pattern.test(category));
}

export function traceMatchesLevel(entry: TraceLogText, filter: LogLevelFilter): boolean {
  if (entry.level === 'debug') return false;
  if (filter === 'error') return entry.level === 'error';
  if (filter === 'warning') return entry.level === 'warning' || entry.level === 'error';
  return true;
}

export function coalesceTraceLogs<T extends TraceLogText>(
  entries: readonly T[],
  windowMilliseconds = 2_000
): CoalescedTraceLog<T>[] {
  const groups: CoalescedTraceLog<T>[] = [];
  for (const entry of entries) {
    const previous = groups.at(-1);
    const previousTime = previous?.entry.occurredAt ? Date.parse(previous.entry.occurredAt) : Number.NaN;
    const currentTime = entry.occurredAt ? Date.parse(entry.occurredAt) : Number.NaN;
    const sameSignature = previous
      && previous.entry.level === entry.level
      && traceLogCategory(previous.entry) === traceLogCategory(entry)
      && traceMessageForDisplay(previous.entry) === traceMessageForDisplay(entry);
    if (
      sameSignature
      && Number.isFinite(previousTime)
      && Number.isFinite(currentTime)
      && currentTime - previousTime >= 0
      && currentTime - previousTime <= windowMilliseconds
    ) {
      previous.entry = entry;
      previous.repeats += 1;
      continue;
    }
    groups.push({ entry, repeats: 1 });
  }
  return groups;
}
