import { runtimeResultSchema, type RuntimeResult } from './public.js';

/** Historical names are confined to persisted-contract migration; live commands use fixed names. */
const legacyCommandNames: Readonly<Record<string, string>> = {
  "agent.decision.resolve": "agent.decision.resolve.v3",
  "agent.inbox.enqueue": "agent.inbox.enqueue.v3",
  "agent.inbox.remove": "agent.inbox.remove.v3",
  "agent.inbox.replace": "agent.inbox.replace.v3",
  "agent.run.cancel": "agent.run.cancel.v3",
  "agent.subagent.interrupt": "agent.subagent.interrupt.v3",
  "agent.subagent.send": "agent.subagent.send.v3",
  "agent.tool_result.detail.get": "agent.tool_result.detail.get.v3",
  "conversation.message.accept": "conversation.message.accept.v3",
  "conversation.message.resolve": "conversation.message.resolve.v3",
  "conversation.session.archive": "conversation.session.archive.v3",
  "conversation.session.create": "conversation.session.create.v3",
  "conversation.session.fork": "conversation.session.fork.v3",
  "conversation.session.rename": "conversation.session.rename.v3",
  "conversation.session.restore": "conversation.session.restore.v3",
  "conversation.session.title.generate": "conversation.session.title.generate.v3",
  "conversation.sessions.query": "conversation.sessions.query.v3",
  "goal.autonomy.start": "goal.autonomy.start.v3",
  "goal.autonomy.transition": "goal.autonomy.transition.v3",
  "goal.put": "goal.put.v3",
  "memory.delete": "memory.delete.v3",
  "memory.put": "memory.put.v3",
  "memory.query": "memory.query.v3",
  "memory.read": "memory.read.v3",
  "memory.recall": "memory.recall.v3",
  "memory.transition": "memory.transition.v3",
  "model.availability.check": "model.availability.check.v3",
  "model.qualification.run": "model.qualification.run.v3",
  "model.quality.evaluate": "model.quality.evaluate.v3",
  "productivity.query": "productivity.query.v3",
  "schedule.create": "schedule.create.v3",
  "schedule.occurrence.retry": "schedule.occurrence.retry.v3",
  "schedule.occurrences.query": "schedule.occurrences.query.v3",
  "schedule.transition": "schedule.transition.v3",
  "schedules.query": "schedules.query.v3",
  "skill.command.load": "skill.command.load.v3",
  "skill.command.resource.read": "skill.command.resource.read.v3",
  "skill.commands.query": "skill.commands.query.v3",
  "todo.snapshot.replace": "todo.snapshot.replace.v3",
  "workflow.advance": "workflow.advance.v3",
  "workflow.cancel": "workflow.cancel.v3",
  "workflow.start": "workflow.start.v3",
  "workspace.document.delete": "workspace.document.delete.v3",
  "workspace.document.move": "workspace.document.move.v3",
  "workspace.document.read": "workspace.document.read.v3",
  "workspace.document.save": "workspace.document.save.v3"
};
const fixedResultNames: Readonly<Record<string, string>> = {
  "agent.decision.resolved.v3": "agent.decision.resolved",
  "agent.inbox.enqueued.v3": "agent.inbox.enqueued",
  "agent.inbox.removed.v3": "agent.inbox.removed",
  "agent.inbox.replaced.v3": "agent.inbox.replaced",
  "agent.run.cancellation.requested.v3": "agent.run.cancellation.requested",
  "agent.run.cancelled.v3": "agent.run.cancelled",
  "agent.subagent.input.sent.v3": "agent.subagent.input.sent",
  "agent.subagent.interrupted.v3": "agent.subagent.interrupted",
  "agent.tool_result.detail.v3": "agent.tool_result.detail",
  "conversation.message.accepted.v3": "conversation.message.accepted",
  "conversation.message.resolved.v3": "conversation.message.resolved",
  "conversation.session.created.v3": "conversation.session.created",
  "conversation.session.forked.v3": "conversation.session.forked",
  "conversation.session.title.generated.v3": "conversation.session.title.generated",
  "conversation.session.updated.v3": "conversation.session.updated",
  "conversation.sessions.query_result.v3": "conversation.sessions.query_result",
  "goal.updated.v3": "goal.updated",
  "memory.deleted.v3": "memory.deleted",
  "memory.query_result.v3": "memory.query_result",
  "memory.read_result.v3": "memory.read_result",
  "memory.recall_result.v3": "memory.recall_result",
  "memory.updated.v3": "memory.updated",
  "model.availability.completed.v3": "model.availability.completed",
  "model.qualification.completed.v3": "model.qualification.completed",
  "model.quality.completed.v3": "model.quality.completed",
  "productivity.query_result.v3": "productivity.query_result",
  "schedule.occurrence.updated.v3": "schedule.occurrence.updated",
  "schedule.occurrences.query_result.v3": "schedule.occurrences.query_result",
  "schedule.updated.v3": "schedule.updated",
  "schedules.query_result.v3": "schedules.query_result",
  "skill.command.loaded.v3": "skill.command.loaded",
  "skill.command.resource.v3": "skill.command.resource",
  "skill.commands.query_result.v3": "skill.commands.query_result",
  "todo.snapshot.replaced.v3": "todo.snapshot.replaced",
  "workflow.updated.v3": "workflow.updated",
  "workspace.document.deleted.v3": "workspace.document.deleted",
  "workspace.document.moved.v3": "workspace.document.moved",
  "workspace.document.read_result.v3": "workspace.document.read_result",
  "workspace.document.saved.v3": "workspace.document.saved"
};
const fixedCommandNames = Object.fromEntries(Object.entries(legacyCommandNames).map(([fixed, legacy]) => [legacy, fixed]));

/** Transport contract versions do not belong to stable business-command identity. */
export function stableRuntimeCommandValue(value: unknown): unknown {
  const input = record(value);
  if (!input || typeof input.kind !== 'string') return value;
  const kind = fixedCommandNames[input.kind] ?? input.kind;
  const result: Record<string, unknown> = { ...input, kind };
  if (legacyCommandNames[kind] || kind === 'projection.snapshot.get' || kind === 'projection.commits.read') delete result.contractVersion;
  return result;
}

/** Proof candidates retain the complete input; never accept an arbitrary historical digest. */
export function legacyRuntimeCommandValues(value: unknown): readonly unknown[] {
  const input = record(value);
  if (!input || typeof input.kind !== 'string') return [value];
  const fixed = fixedCommandNames[input.kind] ?? input.kind;
  const previous = legacyCommandNames[fixed];
  const forms: unknown[] = [value];
  if (previous && typeof input.contractVersion === 'string') {
    for (const contractVersion of ['3.0', '4.0']) forms.push({ ...input, kind: previous, contractVersion });
  } else if ((fixed === 'projection.snapshot.get' || fixed === 'projection.commits.read') && typeof input.contractVersion === 'string') {
    for (const contractVersion of ['3.0', '4.0']) forms.push({ ...input, contractVersion });
  }
  return forms;
}

/** Only the known top-level discriminant changes. User content and immutable histories are untouched. */
export function readPersistedRuntimeResult(value: unknown): RuntimeResult {
  const input = record(value);
  const kind = input && typeof input.kind === 'string' ? fixedResultNames[input.kind] : undefined;
  return runtimeResultSchema.parse(kind ? { ...input, kind } : value);
}

export function fixedPersistedCommandKind(kind: string): string {
  return fixedCommandNames[kind] ?? kind;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
