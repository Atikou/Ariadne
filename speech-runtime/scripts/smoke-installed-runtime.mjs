import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { FrameDecoder, writeFrame } from '../src/protocol.mjs';

const moduleRoot = resolve(argumentValue('--module-root') ?? 'E:\\AI\\AriadneSpeech');
const play = process.argv.includes('--play');
const runtimeRoot = join(moduleRoot, 'runtime');
const voiceRoot = join(moduleRoot, 'voices', 'builtin', 'zh-cn-melo-official', '1.0.0');
const manifest = JSON.parse(await readFile(join(voiceRoot, 'voice.json'), 'utf8'));
const child = spawn(join(runtimeRoot, 'node.exe'), [join(runtimeRoot, 'dist', 'sidecar.mjs'), '--module-root', moduleRoot], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe']
});
const decoder = new FrameDecoder();
const pending = new Map();
const events = [];
let nextId = 0;
let stderr = '';
child.stdout.on('data', (chunk) => decoder.accept(chunk));
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
decoder.on('message', (message) => {
  if (message.type === 'event') events.push(message.event);
  if (message.type !== 'response') return;
  const waiter = pending.get(message.requestId);
  if (!waiter) return;
  pending.delete(message.requestId);
  message.ok ? waiter.resolve(message.result) : waiter.reject(new Error(message.error));
});

try {
  await request('hello', { protocolVersion: 1 });
  await request('configure', {
    moduleRoot,
    inputDeviceId: 'default',
    outputDeviceId: 'default',
    backgroundWakeEnabled: false,
    wakeKeywords: ['Ariadne'],
    background: false,
    listenAllowed: true,
    activeVoice: { root: voiceRoot, manifest }
  }, 60_000);
  const status = await request('status.get', {});
  if (status.availability !== 'available' || !status.capabilities.includes('stt') || !status.capabilities.includes('tts')) {
    throw new Error(`Expected fully available STT/TTS status, received ${JSON.stringify(status)}`);
  }
  if (play) {
    await request('tts.synthesize', {
      turnId: 'installed-runtime-smoke', sequence: 0,
      text: '你好，Ariadne 语音模块已经完成安装。', final: true
    }, 120_000);
  }
  await request('shutdown', { reason: 'smoke_complete' });
  process.stdout.write(`${JSON.stringify({ status, played: play, events: events.map((event) => event.kind) }, null, 2)}\n`);
} catch (error) {
  child.kill();
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr.slice(-1000)}`);
}

function request(method, params, timeoutMs = 15_000) {
  const requestId = `smoke-${++nextId}`;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Timed out: ${method}`));
    }, timeoutMs);
    pending.set(requestId, {
      resolve(value) { clearTimeout(timer); resolvePromise(value); },
      reject(error) { clearTimeout(timer); reject(error); }
    });
    writeFrame(child.stdin, { type: 'request', protocolVersion: 1, requestId, method, params });
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
