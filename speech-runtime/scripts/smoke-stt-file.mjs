import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const moduleRoot = resolve(argumentValue('--module-root') ?? 'E:\\AI\\AriadneSpeech');
const wavePath = resolve(argumentValue('--wave') ?? join(moduleRoot, 'voices', 'builtin', 'zh-cn-melo-official', '1.0.0', 'sample.wav'));
const sherpa = require(join(moduleRoot, 'runtime', 'node_modules', 'sherpa-onnx-node'));
const modelRoot = join(moduleRoot, 'models', 'stt');
const model = JSON.parse((await readFile(join(modelRoot, 'model.json'), 'utf8')).replace(/^\uFEFF/u, ''));
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: {
      encoder: join(modelRoot, model.encoder), decoder: join(modelRoot, model.decoder), joiner: join(modelRoot, model.joiner)
    },
    tokens: join(modelRoot, model.tokens), numThreads: 4, provider: 'cpu', debug: false
  },
  decodingMethod: 'greedy_search', maxActivePaths: 4, enableEndpoint: true
});
const wave = sherpa.readWave(wavePath);
const samples = wave.sampleRate === 16000 ? wave.samples : new sherpa.LinearResampler(wave.sampleRate, 16000).resample(wave.samples);
const stream = recognizer.createStream();
const partials = [];
const started = performance.now();
for (let offset = 0; offset < samples.length; offset += 1600) {
  stream.acceptWaveform({ samples: samples.subarray(offset, Math.min(offset + 1600, samples.length)), sampleRate: 16000 });
  while (recognizer.isReady(stream)) recognizer.decode(stream);
  const partial = recognizer.getResult(stream).text.trim();
  if (partial && partial !== partials.at(-1)) partials.push(partial);
}
stream.inputFinished();
while (recognizer.isReady(stream)) recognizer.decode(stream);
const text = recognizer.getResult(stream).text.trim();
const elapsedSeconds = (performance.now() - started) / 1000;
const audioSeconds = samples.length / 16000;
if (!text) throw new Error('Real Streaming Zipformer test returned an empty transcript.');
process.stdout.write(`${JSON.stringify({ text, partialCount: partials.length, audioSeconds, elapsedSeconds, realTimeFactor: elapsedSeconds / audioSeconds }, null, 2)}\n`);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
