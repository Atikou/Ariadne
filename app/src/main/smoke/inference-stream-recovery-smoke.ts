import type { BrowserWindow } from 'electron';
import type { RuntimeEventEnvelope } from '@ariadne/protocol/public';
import { IPC_CHANNELS } from '@shared/ipc';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { showSmokeWindow } from './window-visibility';
import { installSmokeProjectionProbe } from './projection-probe';

/** Test-only transport faults around real Provider/Runtime/Projection/DOM behavior. */
export async function verifyInferenceStreamRecovery(window: BrowserWindow, modelId: string, outputRoot: string): Promise<boolean> {
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
    const wait = async (probe, stage) => {
      const end = Date.now() + 30000;
      while (Date.now() < end) { const value = await probe(); if (value) return value; await new Promise(r => setTimeout(r, 40)); }
      throw new Error('inference_recovery_smoke_timeout:' + stage);
    };
    const request = async command => {
      const result = await window.ariadne.runtime.request(command);
      if (!result.ok) throw new Error('inference_recovery_request_failed:' + command.kind + ':' + result.error?.code);
      return result.value;
    };
    const snapshot = async () => window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(process.env.ARIADNE_SMOKE_WORKSPACE_ID)});
    const partial = () => [...document.querySelectorAll('.assistant-message-content > .message-content')]
      .map(node => node.textContent?.trim() ?? '').find(text => text.startsWith('ARIADNE_')
        && 'ARIADNE_SMOKE_STREAM_RECOVERY_OK'.startsWith(text) && text !== 'ARIADNE_SMOKE_STREAM_RECOVERY_OK');
  `;
  try {
    const initial = await window.webContents.executeJavaScript(`(async () => {
      ${support}
      await wait(() => document.visibilityState === 'visible', 'initial_visibility');
      await request({kind:'model.qualification.run',contractVersion:'5.0',modelId:${JSON.stringify(modelId)}});
      const priorInput = document.querySelector('.composer textarea');
      document.querySelector('.conversation-create-button').click();
      const input = await wait(() => {
        const current = document.querySelector('.composer textarea');
        return current instanceof HTMLTextAreaElement && current.isConnected && current !== priorInput ? current : null;
      }, 'new_draft_composer');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'ariadne-smoke:stream_recovery');
      input.dispatchEvent(new Event('input', {bubbles:true}));
      (await wait(() => { const button = document.querySelector('.send-button'); return button && !button.disabled && button; }, 'send')).click();
      const text = await wait(partial, 'initial_partial');
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
    await installSmokeProjectionProbe(window);
    showSmokeWindow(window);
    const recovered = await window.webContents.executeJavaScript(`(async () => {
      ${support}
      await wait(() => document.visibilityState === 'visible', 'reload_visibility');
      const sessionId = ${JSON.stringify(initial.sessionId)};
      (await wait(() => document.querySelector('.conversation-row[data-session-id="' + sessionId + '"] .conversation-row-main'), 'reload_session')).click();
      const text = await wait(() => { const value = partial(); return value && value.length >= ${initial.text.length} && value; }, 'recovered_partial');
      const state = await snapshot();
      if (!state.inferenceStreams.some(item => item.sessionId === sessionId && item.status === 'streaming')) {
        throw new Error('inference_recovery_only_observed_terminal');
      }
      await wait(() => [...document.querySelectorAll('.assistant-message-content > .message-content')]
        .some(node => node.textContent?.trim() === 'ARIADNE_SMOKE_STREAM_RECOVERY_OK'), 'terminal_dom');
      await wait(async () => (await snapshot()).messages.some(item => item.sessionId === sessionId
        && item.role === 'assistant' && item.status === 'completed' && item.content === 'ARIADNE_SMOKE_STREAM_RECOVERY_OK'), 'terminal_projection');
      const terminal = await snapshot();
      return terminal.messages.filter(item => item.sessionId === sessionId && item.role === 'assistant'
        && item.status === 'completed' && item.content === 'ARIADNE_SMOKE_STREAM_RECOVERY_OK').length === 1;
    })()`, true) as boolean;
    if (!dropped || !duplicated || !recovered) {
      throw new Error(`inference_recovery_verification_failed:${JSON.stringify({ dropped, duplicated, recovered })}`);
    }
    const visibility = await window.webContents.executeJavaScript('document.visibilityState') as string;
    await writeFile(join(outputRoot, 'inference-stream-recovery.json'), JSON.stringify({passed:true,dropped,duplicated,recovered,
      initialPartial:initial.text,visibility,bounds:window.getBounds()}, null, 2));
    return true;
  } catch (error) {
    const page = await window.webContents.executeJavaScript(`(async () => ({
      assistant: [...document.querySelectorAll('.assistant-message-content')].map(node => node.textContent?.slice(0, 400)),
      placeholders: [...document.querySelectorAll('.message-body-placeholder')].map(node => node.textContent),
      viewport: (() => { const node = document.querySelector('.message-viewport'); return node && {top:node.scrollTop,height:node.clientHeight,total:node.scrollHeight}; })(),
      status: document.querySelector('.runtime-status')?.textContent,
      visibility: document.visibilityState,
      observed: await new Promise(resolve => {
        const target = document.querySelector('.message-body-placeholder');
        if (!target) { resolve(null); return; }
        const timer = setTimeout(() => { observer.disconnect(); resolve('no_intersection_callback'); }, 1000);
        const observer = new IntersectionObserver(entries => {
          clearTimeout(timer); observer.disconnect();
          resolve(entries.map(entry => ({intersecting:entry.isIntersecting,ratio:entry.intersectionRatio,
            target:{x:entry.boundingClientRect.x,y:entry.boundingClientRect.y,width:entry.boundingClientRect.width,height:entry.boundingClientRect.height},
            root:entry.rootBounds && {x:entry.rootBounds.x,y:entry.rootBounds.y,width:entry.rootBounds.width,height:entry.rootBounds.height}})));
        }, {root:target.closest('.message-viewport')}); observer.observe(target);
      })
    }))()`).catch(() => null);
    const native = {visible:window.isVisible(),minimized:window.isMinimized(),bounds:window.getBounds()};
    await writeFile(join(outputRoot, 'inference-stream-recovery-failure.json'), JSON.stringify({error:String(error),dropped,duplicated,page,native}, null, 2));
    const manual = await window.webContents.executeJavaScript(`(async () => {
      for (const button of document.querySelectorAll('.message-body-placeholder button')) button.click();
      await new Promise(resolve => setTimeout(resolve, 1000));
      return {assistant:[...document.querySelectorAll('.assistant-message-content')].map(node=>node.textContent?.slice(0,400)),
        placeholders:[...document.querySelectorAll('.message-body-placeholder')].map(node=>node.textContent)};
    })()`).catch(() => null);
    await writeFile(join(outputRoot, 'inference-stream-recovery-manual-diagnostic.json'), JSON.stringify(manual, null, 2));
    await window.webContents.capturePage().then(page => writeFile(join(outputRoot, 'inference-stream-recovery-failure.png'), page.toPNG()))
      .catch(captureError => writeFile(join(outputRoot, 'inference-stream-recovery-capture-error.txt'), String(captureError)));
    throw error;
  } finally { window.webContents.send = originalSend; }
}
