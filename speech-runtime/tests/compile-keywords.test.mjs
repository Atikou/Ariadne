import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

test('keyword compiler emits Chinese partial-pinyin and an English pronunciation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-kws-'));
  const tokens = ['x', 'iǎo', 'ài', 't', 'óng', 'ué', 'AE', 'R', 'IY0', 'D', 'N'];
  await writeFile(join(root, 'tokens.txt'), tokens.map((token, index) => `${token} ${index}`).join('\n'), 'utf8');
  await writeFile(join(root, 'en.phone'), '', 'utf8');
  await writeFile(join(root, 'input.txt'), '小爱同学 @小爱同学\nAriadne @Ariadne\n', 'utf8');
  await run(process.execPath, [
    resolve('tools/compile-keywords.mjs'), '--tokens', join(root, 'tokens.txt'),
    '--lexicon', join(root, 'en.phone'), '--input', join(root, 'input.txt'),
    '--output', join(root, 'output.txt')
  ]);
  assert.equal(await readFile(join(root, 'output.txt'), 'utf8'),
    'x iǎo ài t óng x ué @小爱同学\nAE R IY0 AE D N IY0 @Ariadne\n');
});

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(stderr)));
  });
}
