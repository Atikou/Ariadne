import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');
const sourceRoot = resolve(argumentValue('--source') ?? '');
const moduleRoot = resolve(argumentValue('--module-root') ?? 'E:\\AI\\AriadneSpeech');
const voiceId = 'zh-cn-melo-official';
const version = '1.0.0';
const targetRoot = join(moduleRoot, 'voices', 'builtin', voiceId, version);
const stagingRoot = `${targetRoot}.staging-${process.pid}`;

await assertFile(join(sourceRoot, 'model.onnx'));
await assertFile(join(sourceRoot, 'tokens.txt'));
await assertFile(join(sourceRoot, 'lexicon.txt'));
await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });

for (const name of ['model.onnx', 'tokens.txt', 'lexicon.txt', 'date.fst', 'number.fst', 'phone.fst', 'LICENSE', 'README.md']) {
  const source = join(sourceRoot, name);
  if (await exists(source)) await cp(source, join(stagingRoot, name), { recursive: true });
}

await writeFile(join(stagingRoot, 'model.onnx.json'), `${JSON.stringify({
  format: 'sherpa-onnx-vits',
  upstream: 'vits-melo-tts-zh_en',
  speakerId: 0,
  sampleRate: 44100
}, null, 2)}\n`, 'utf8');

const upstreamLicense = await readFile(join(sourceRoot, 'LICENSE'), 'utf8').catch(() => 'The upstream archive did not include a readable LICENSE file.');
await writeFile(join(stagingRoot, 'MODEL_CARD.md'), `# Ariadne built-in Mandarin voice\n\n` +
  `- Upstream model: vits-melo-tts-zh_en\n` +
  `- Source: https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models\n` +
  `- Converted from: https://huggingface.co/myshell-ai/MeloTTS-Chinese\n` +
  `- Intended use: local Ariadne speech synthesis only\n` +
  `- Redistribution: disabled until a separate weight-license audit approves it\n\n` +
  `## License file bundled by upstream\n\n\`\`\`text\n${upstreamLicense.trim()}\n\`\`\`\n`, 'utf8');

const tts = await sherpa.OfflineTts.createAsync({
  model: {
    vits: {
      model: join(stagingRoot, 'model.onnx'),
      tokens: join(stagingRoot, 'tokens.txt'),
      lexicon: join(stagingRoot, 'lexicon.txt')
    },
    debug: false,
    numThreads: 2,
    provider: 'cpu'
  },
  maxNumSentences: 1,
  ruleFsts: ['date.fst', 'number.fst', 'phone.fst']
    .filter((name) => name !== 'phone.fst' || true)
    .map((name) => join(stagingRoot, name))
    .filter((path) => path)
    .join(',')
});
const audio = await tts.generateAsync({
  text: '你好，欢迎使用 Ariadne 语音模块。',
  generationConfig: new sherpa.GenerationConfig({ sid: 0, speed: 1.0 })
});
if (!audio?.samples?.length || !audio.sampleRate) throw new Error('Built-in voice sample synthesis returned no audio.');
if (!sherpa.writeWave(join(stagingRoot, 'sample.wav'), audio)) throw new Error('Failed to write built-in voice sample.');

const ruleFsts = [];
for (const name of ['date.fst', 'number.fst', 'phone.fst']) if (await exists(join(stagingRoot, name))) ruleFsts.push(name);
const manifest = {
  schemaVersion: 1,
  engine: 'sherpa-onnx-vits',
  voiceId,
  version,
  displayName: '官方普通话（MeloTTS）',
  languages: ['zh-CN', 'en'],
  sampleRate: audio.sampleRate,
  speakerId: 0,
  files: {
    model: 'model.onnx',
    config: 'model.onnx.json',
    tokens: 'tokens.txt',
    lexicon: 'lexicon.txt',
    sample: 'sample.wav',
    modelCard: 'MODEL_CARD.md',
    ruleFsts
  },
  license: {
    name: 'See bundled upstream LICENSE and MODEL_CARD',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models',
    redistributionAllowed: false
  }
};
await writeFile(join(stagingRoot, 'voice.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
const checksums = {};
for (const path of await filesBelow(stagingRoot)) {
  const key = relative(stagingRoot, path).replaceAll('\\', '/');
  if (key !== 'checksums.json') checksums[key] = await sha256(path);
}
await writeFile(join(stagingRoot, 'checksums.json'), `${JSON.stringify(checksums, null, 2)}\n`, 'utf8');

await rm(targetRoot, { recursive: true, force: true });
await mkdir(resolve(targetRoot, '..'), { recursive: true });
await rename(stagingRoot, targetRoot);
process.stdout.write(`${targetRoot}\n`);

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function assertFile(path) {
  if (!await exists(path) || !(await stat(path)).isFile()) throw new Error(`Required upstream voice file is missing: ${basename(path)}`);
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function filesBelow(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await filesBelow(path));
    else if (entry.isFile()) output.push(path);
  }
  return output.sort();
}

async function sha256(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}
