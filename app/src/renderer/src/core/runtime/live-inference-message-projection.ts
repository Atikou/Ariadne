import type { ProjectionCacheSnapshot } from './projection/projection-cache';
import { LiveInferenceStreamStore } from './live-inference-stream-store';
import { memoizeInputs } from './memoize-inputs';
import {
  presentInferenceStreamMessage,
  type RuntimeMessage
} from './runtime-projection-presenter';

export function reconcileLiveInferenceStreams(
  store: LiveInferenceStreamStore,
  projection: ProjectionCacheSnapshot
): void {
  const settledRunIds = new Set(projection.runs
    .filter((run) => ['completed', 'failed', 'cancelled'].includes(run.status))
    .map((run) => run.runId));
  for (const message of projection.messages) {
    if (
      message.role === 'assistant'
      && message.status === 'completed'
      && message.runId !== undefined
    ) settledRunIds.add(message.runId);
  }
  store.discardRuns(settledRunIds);
  store.reconcile(projection.inferenceStreams);
}

const messageViews = new WeakMap<LiveInferenceStreamStore, ReturnType<typeof createMessageView>>();
function createMessageView() {
  return memoizeInputs((heads: ReturnType<LiveInferenceStreamStore['getSnapshot']>, terminalAssistantRunIds: ReadonlySet<string>) => heads.flatMap(stream => {
    if (terminalAssistantRunIds.has(stream.runId)) return [];
    const message = presentInferenceStreamMessage(stream);
    return message === null ? [] : [message];
  }));
}

export function presentInferenceMessages(
  store: LiveInferenceStreamStore,
  terminalAssistantRunIds: ReadonlySet<string>
): RuntimeMessage[] {
  const view = messageViews.get(store) ?? createMessageView();
  messageViews.set(store, view);
  return view(store.getSnapshot(), terminalAssistantRunIds);
}
