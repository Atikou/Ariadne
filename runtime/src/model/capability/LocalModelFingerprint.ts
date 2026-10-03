import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import type { LocalModelDescriptor } from '../local/types.js';

const ADAPTER_IDENTITY = Object.freeze({
  adapter: 'ariadne.embedded-local',
  adapterProtocolVersion: 1
});
const METADATA_FILES = new Set([
  'model.json',
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'generation_config.json',
  'chat_template.jinja'
]);

/** Hashes the complete local weight set and every prompt/tokenizer-affecting input. */
export async function fingerprintLocalModel(model: LocalModelDescriptor): Promise<string> {
  const files = await fingerprintFiles(model);
  const digest = createHash('sha256');
  digest.update(JSON.stringify({
    identity: ADAPTER_IDENTITY,
    runtime: model.runtime,
    contextSize: model.contextSize ?? null,
    gpuLayers: model.gpuLayers ?? null,
    device: model.device ?? null,
    maxTokens: model.maxTokens ?? null,
    routerProfile: model.routerProfile ?? null
  }), 'utf8');
  for (const file of files) {
    digest.update(`\u0000${path.basename(file)}\u0000`, 'utf8');
    await appendFile(digest, file);
  }
  if (model.runtime === 'llama.cpp') {
    const packageEntry = createRequire(import.meta.url).resolve('node-llama-cpp');
    const packageRoot = path.dirname(path.dirname(packageEntry));
    for (const [label, file] of [
      ['node-llama-cpp/package.json', path.join(packageRoot, 'package.json')],
      ['llama.cpp/build', path.join(packageRoot, 'llama', 'llama.cpp.info.json')]
    ] as const) {
      digest.update(`\u0000${label}\u0000`, 'utf8');
      await appendFile(digest, file);
    }
  }
  return `sha256:${digest.digest('hex')}`;
}

async function fingerprintFiles(model: LocalModelDescriptor): Promise<string[]> {
  const source = path.resolve(model.sourcePath);
  if ((await stat(source)).isFile()) return [source];
  const entries = await readdir(source, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && (
      METADATA_FILES.has(entry.name.toLowerCase())
      || entry.name.toLowerCase().endsWith('.gguf')
      || entry.name.toLowerCase().endsWith('.safetensors')
    ))
    .map((entry) => path.join(source, entry.name))
    .sort(compareCodeUnits);
}

async function appendFile(digest: ReturnType<typeof createHash>, file: string): Promise<void> {
  const stream = createReadStream(file);
  for await (const chunk of stream) digest.update(chunk as Buffer);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
