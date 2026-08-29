import { resolve } from 'node:path';
import { FrameDecoder, writeFrame } from './protocol.mjs';
import { SherpaEngine } from './sherpa-engine.mjs';

const PROTOCOL_VERSION = 1;
const moduleRoot = resolve(argumentValue('--module-root') ?? process.env.ARIADNE_SPEECH_ROOT ?? 'E:\\AI\\AriadneSpeech');
const emit = (event) => writeFrame(process.stdout, { type: 'event', protocolVersion: PROTOCOL_VERSION, event });
const engine = new SherpaEngine(moduleRoot, emit);
await engine.initialize();

if (process.argv.includes('--self-test')) {
  process.stderr.write(`${JSON.stringify({ protocolVersion: PROTOCOL_VERSION, moduleRoot, status: engine.status() })}\n`);
  process.exit(0);
}

const decoder = new FrameDecoder();
process.stdin.on('data', (chunk) => {
  try { decoder.accept(chunk); } catch (error) { process.stderr.write(`Protocol error: ${error.message}\n`); process.exitCode = 2; }
});
decoder.on('message', (message) => void accept(message));
process.stdin.resume();

async function accept(message) {
  const requestId = typeof message?.requestId === 'string' ? message.requestId : 'invalid';
  try {
    if (message?.type !== 'request' || message.protocolVersion !== PROTOCOL_VERSION || typeof message.method !== 'string') {
      throw new Error('request_invalid');
    }
    const result = await dispatch(message.method, message.params ?? {});
    writeFrame(process.stdout, { type: 'response', protocolVersion: PROTOCOL_VERSION, requestId, ok: true, result });
    if (message.method === 'shutdown') setImmediate(() => process.exit(0));
  } catch (error) {
    writeFrame(process.stdout, {
      type: 'response', protocolVersion: PROTOCOL_VERSION, requestId, ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'hello':
      if (params.protocolVersion !== PROTOCOL_VERSION) throw new Error('protocol_version_incompatible');
      return { protocolVersion: PROTOCOL_VERSION, engine: 'sherpa-onnx' };
    case 'configure': await engine.configure(params); return {};
    case 'status.get': return engine.status();
    case 'recognition.start': await engine.startRecognition(params); return {};
    case 'recognition.stop': await engine.stopRecognition(params); return {};
    case 'recognition.cancel': await engine.cancelRecognition(); return {};
    case 'tts.synthesize': await engine.synthesize(params); return {};
    case 'tts.cancel': await engine.cancelSynthesis(params); return {};
    case 'voice.test': await engine.testVoice(params); return {};
    case 'voice.load': await engine.loadVoice(params); return {};
    case 'shutdown': await engine.shutdown(); return {};
    default: throw new Error('method_unknown');
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
