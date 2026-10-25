import { describe, expect, it, vi } from 'vitest';
import type { AriadneApi } from '../src/shared/contract';
import type { MessageFeatureStore } from '../src/renderer/src/core/runtime/features/message-feature-store';
import type { RunFeatureStore } from '../src/renderer/src/core/runtime/features/run-feature-store';
import type { SessionFeatureStore } from '../src/renderer/src/core/runtime/features/session-feature-store';
import { SpeechAgentBridge } from '../src/renderer/src/core/speech/speech-agent-bridge';
import type { RuntimeMessage } from '../src/renderer/src/core/runtime/runtime-projection-presenter';

describe('SpeechAgentBridge', () => {
  it('routes recognized text through the ordinary message feature command', async () => {
    const send = vi.fn(async () => ({ messageId: 'message-1', sessionId: 'session-1' }));
    const bridge = new SpeechAgentBridge(
      speechApi(),
      feature({ messages: [], pendingOverlayIds: [] }, { send }) as unknown as MessageFeatureStore,
      feature({ runs: [], activities: [], agentInputDeliveries: [] }) as unknown as RunFeatureStore,
      feature({ sessions: [], selectedSessionId: 'session-1', planModeSessionIds: [] }) as unknown as SessionFeatureStore,
      memoryStorage()
    );

    bridge.initialize();
    bridge.acceptVoiceText('  hello agent  ', false);

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('hello agent', {
      sessionId: 'session-1',
      selectSession: true
    }));
    bridge.dispose();
  });

  it('contains message delivery failure inside Speech health reporting', async () => {
    const expected = new Error('delivery failed');
    const send = vi.fn(async () => { throw expected; });
    const listener = vi.fn();
    const bridge = new SpeechAgentBridge(
      speechApi(),
      feature({ messages: [], pendingOverlayIds: [] }, { send }) as unknown as MessageFeatureStore,
      feature({ runs: [], activities: [], agentInputDeliveries: [] }) as unknown as RunFeatureStore,
      feature({ sessions: [], selectedSessionId: null, planModeSessionIds: [] }) as unknown as SessionFeatureStore,
      memoryStorage()
    );
    bridge.onError(listener);
    bridge.initialize();

    bridge.acceptVoiceText('hello', false);

    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(expected));
    bridge.dispose();
  });
  it('requests unread terminal content and delays final synthesis until the complete body arrives', async () => {
    const api = speechApi(), send = vi.fn(async () => ({ messageId: 'source', sessionId: 'session-1' })), loadBody = vi.fn(async () => undefined);
    const messages = feature({ messages: [] as RuntimeMessage[], pendingOverlayIds: [] as string[] }, { send, loadBody });
    const runs = feature({ runs: [] as Array<{ runId: string; sessionId: string; sourceMessageId: string; status: string }>, activities: [], agentInputDeliveries: [] });
    const bridge = new SpeechAgentBridge(api, messages as unknown as MessageFeatureStore, runs as unknown as RunFeatureStore,
      feature({ sessions: [], selectedSessionId: 'session-1', planModeSessionIds: [] }) as unknown as SessionFeatureStore, memoryStorage());
    bridge.initialize(); bridge.acceptVoiceText('请回答', false); await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await Promise.resolve();
    runs.update({ runs: [{ runId: 'run-1', sessionId: 'session-1', sourceMessageId: 'source', status: 'running' }], activities: [], agentInputDeliveries: [] });
    const unread: RuntimeMessage = { messageId: 'answer', sessionId: 'session-1', runId: 'run-1', role: 'assistant', status: 'completed',
      bodyState: 'unloaded', bodyReadToken: `sha256:${'a'.repeat(64)}`, createdAt: '2032-01-01T00:00:00.000Z' };
    messages.update({ messages: [unread], pendingOverlayIds: [] });
    runs.update({ runs: [{ runId: 'run-1', sessionId: 'session-1', sourceMessageId: 'source', status: 'completed' }], activities: [], agentInputDeliveries: [] });
    expect(loadBody).toHaveBeenCalledTimes(1); expect(api.synthesize).not.toHaveBeenCalled();
    messages.update({ messages: [{ ...unread, bodyState: 'loaded', content: '完整回答。' }], pendingOverlayIds: [] });
    await vi.waitFor(() => expect(api.synthesize).toHaveBeenCalledWith({ turnId: 'run-1', sequence: 0, text: '完整回答。', final: true }));
    bridge.dispose();
  });
});

function feature<T>(snapshot: T, commands: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>();
  return {
    ...commands,
    update(next: T) { snapshot = next; for (const listener of listeners) listener(); },
    view: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    }
  };
}

function speechApi(): AriadneApi['speech'] {
  return {
    getStatus: vi.fn(),
    startRecognition: vi.fn(),
    stopRecognition: vi.fn(),
    cancelRecognition: vi.fn(),
    synthesize: vi.fn(),
    cancelSynthesis: vi.fn(),
    importVoicePack: vi.fn(),
    activateVoice: vi.fn(),
    onEvent: vi.fn(() => () => undefined)
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); }
  };
}
