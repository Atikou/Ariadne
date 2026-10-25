import type { ProjectionPresentation } from './projection/projection-presentation';
import type { PublicRunCatalogSummary } from '@ariadne/protocol/public';
import { memoizeInputs } from './memoize-inputs';
import { mergeLiveMessages } from './runtime-message-projection';
import type { RuntimeMessage } from './runtime-projection-presenter';
import {
  presentDiagnostic, presentMessage, presentModel, presentPermissionDecision, presentPlanDecision,
  presentUserQuestionDecision, presentRun, presentRunActivities, presentSession
} from './runtime-projection-presenter';

export function isTerminalRunSummary(run: Pick<PublicRunCatalogSummary, 'status'>): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
}

/** Derived views follow their owning collection, independently of stream and cursor updates. */
export class RuntimeProjectionViews {
  readonly sessions = memoizeInputs((items: ProjectionPresentation['sessions']) => items.map(presentSession));
  readonly models = memoizeInputs((items: ProjectionPresentation['models']) => items.map(presentModel));
  readonly runs = memoizeInputs((items: ProjectionPresentation['runs']) => items.map(presentRun));
  readonly activities = memoizeInputs((items: ProjectionPresentation['runs']) => items.flatMap(presentRunActivities));
  readonly trace = memoizeInputs((items: ProjectionPresentation['diagnostics']) => items.map(presentDiagnostic));
  readonly decisions = memoizeInputs((items: ProjectionPresentation['decisions']) => ({
    permissions: items.flatMap(item => { const value = presentPermissionDecision(item); return value === null ? [] : [value]; }),
    planHandoffs: items.flatMap(item => { const value = presentPlanDecision(item); return value === null ? [] : [value]; }),
    userQuestions: items.flatMap(item => { const value = presentUserQuestionDecision(item); return value === null ? [] : [value]; })
  }));
  readonly messages = memoizeInputs((items: ProjectionPresentation['messages']) => {
    const messages = items.map(presentMessage);
    const bySession = new Map<string, typeof messages>();
    const terminalAssistantRunIds = new Set<string>();
    for (const message of messages) {
      const session = bySession.get(message.sessionId) ?? [];
      session.push(message);
      bySession.set(message.sessionId, session);
      if (message.role === 'assistant' && message.status === 'completed' && message.runId !== undefined) {
        terminalAssistantRunIds.add(message.runId);
      }
    }
    return { bySession, terminalAssistantRunIds };
  });
  readonly pendingOverlayIds = memoizeInputs((id: string | null) => id === null ? [] : [id]);
  readonly selectedMessages = memoizeInputs((bySession: Map<string, RuntimeMessage[]>, live: RuntimeMessage[], selected: string | null) =>
    mergeLiveMessages(bySession.get(selected ?? '') ?? [], live.filter(message => message.sessionId === selected)));
}
