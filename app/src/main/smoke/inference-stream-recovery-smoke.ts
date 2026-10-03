import type { BrowserWindow } from 'electron';
import type { RuntimeEventEnvelope } from '@ariadne/protocol/public';
import { IPC_CHANNELS } from '@shared/ipc';

/** Test-only transport faults around real Provider/Runtime/Projection/DOM behavior. */
export async function verifyInferenceStreamRecovery(window: BrowserWindow, modelId: string): Promise<boolean> {
  const originalSend = window.webContents.send;
  let dropped = false;
  let duplicated = false;
  window.webContents.send = function (channel: string, ...args: unknown[]): void {
    const envelope = args[0] as RuntimeEventEnvelope | undefined;
    if (channel === IPC_CHANNELS.runtimeEvent && envelope?.event.kind === 'inference.chunk.observed') {
      if (!dropped && envelope.event.sequence === 2) { dropped = true; return; }
      if (!duplicated && envelope.event.sequence === 1) {
        duplicated = true;
        originalSend.call(this, channel, ...args);
      }
    }
    originalSend.call(this, channel, ...args);
  };
  const support = `
    const wait = async (probe) => {
      const end = Date.now() + 30000;
      while (Date.now() < end) { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r, 40)); }
      throw new Error('inference_recovery_smoke_timeout');
    };
    const request = async command => {
      const result = await window.ariadne.runtime.request(command);
      if (!result.ok) throw new Error('inference_recovery_request_failed:' + command.kind + ':' + result.error?.code);
      return result.value;
    };
    const snapshot = async () => (await request({kind:'projection.snapshot.get',contractVersion:'4.0'})).snapshot;
    const partial = () => [...document.querySelectorAll('.assistant-message-content > .message-content')]
      .map(node => node.textContent?.trim() ?? '').find(text => text.startsWith('ARIADNE_')
        && 'ARIADNE_SMOKE_STREAM_RECOVERY_OK'.startsWith(text) && text !== 'ARIADNE_SMOKE_STREAM_RECOVERY_OK');
  `;
  try {
    const initial = await window.webContents.executeJavaScript(`(async () => {
      ${support}
      await request({kind:'model.qualification.run.v3',contractVersion:'4.0',modelId:${JSON.stringify(modelId)}});
      document.querySelector('.conversation-create-button').click();
      const input = await wait(() => document.querySelector('.composer textarea'));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'ariadne-smoke:stream_recovery');
      input.dispatchEvent(new Event('input', {bubbles:true}));
      (await wait(() => { const button = document.querySelector('.send-button'); return button && !button.disabled && button; })).click();
      const text = await wait(partial);
      const state = await snapshot();
      const message = state.messages.find(item => item.role === 'user' && item.content === 'ariadne-smoke:stream_recovery');
      if (!message) throw new Error('inference_recovery_message_missing');
      return {text, sessionId:message.sessionId};
    })()`, true) as { text: string; sessionId: string };

    const loaded = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { window.webContents.removeListener('did-finish-load', done); reject(new Error('inference_recovery_reload_timeout')); }, 30_000);
      const done = () => { clearTimeout(timeout); resolve(); };
      window.webContents.once('did-finish-load', done);
    });
    window.webContents.reload();
    await loaded;
    const recovered = await window.webContents.executeJavaScript(`(async () => {
      ${support}
      const sessionId = ${JSON.stringify(initial.sessionId)};
      (await wait(() => document.querySelector('.conversation-row[data-session-id="' + sessionId + '"] .conversation-row-main'))).click();
      const text = await wait(() => { const value = partial(); return value && value.length >= ${initial.text.length} && value; });
      const state = await snapshot();
      if (!state.inferenceStreams.some(item => item.sessionId === sessionId && item.status === 'streaming')) {
        throw new Error('inference_recovery_only_observed_terminal');
      }
      await wait(() => [...document.querySelectorAll('.assistant-message-content > .message-content')]
        .some(node => node.textContent?.trim() === 'ARIADNE_SMOKE_STREAM_RECOVERY_OK'));
      await wait(async () => (await snapshot()).messages.some(item => item.sessionId === sessionId
        && item.role === 'assistant' && item.status === 'completed' && item.content === 'ARIADNE_SMOKE_STREAM_RECOVERY_OK'));
      const terminal = await snapshot();
      return terminal.messages.filter(item => item.sessionId === sessionId && item.role === 'assistant'
        && item.status === 'completed' && item.content === 'ARIADNE_SMOKE_STREAM_RECOVERY_OK').length === 1;
    })()`, true) as boolean;
    if (!dropped || !duplicated || !recovered) {
      throw new Error(`inference_recovery_verification_failed:${JSON.stringify({ dropped, duplicated, recovered })}`);
    }
    return true;
  } finally { window.webContents.send = originalSend; }
}
