import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pinyin } from 'pinyin-pro';

const BUILTIN_ENGLISH = new Map([
  ['ARIADNE', ['AE', 'R', 'IY0', 'AE', 'D', 'N', 'IY0']]
]);
const tokensPath = resolve(requiredArgument('--tokens'));
const lexiconPath = resolve(requiredArgument('--lexicon'));
const inputPath = resolve(requiredArgument('--input'));
const outputPath = resolve(requiredArgument('--output'));
const validTokens = new Set((await readFile(tokensPath, 'utf8')).split(/\r?\n/u).map((line) => line.trim().split(/\s+/u)[0]).filter(Boolean));
const lexicon = parseLexicon(await readFile(lexiconPath, 'utf8'));
const output = [];

for (const rawLine of (await readFile(inputPath, 'utf8')).split(/\r?\n/u)) {
  const line = rawLine.trim();
  if (!line) continue;
  const marker = line.lastIndexOf(' @');
  const phrase = (marker >= 0 ? line.slice(0, marker) : line).trim();
  const label = (marker >= 0 ? line.slice(marker + 2) : phrase).trim().replaceAll(' ', '_');
  if (!phrase || !label) throw new Error('Keyword and label must not be empty.');
  const encoded = encodePhrase(phrase, lexicon);
  const missing = encoded.filter((token) => !validTokens.has(token));
  if (missing.length) throw new Error(`Keyword "${phrase}" contains unsupported tokens: ${[...new Set(missing)].join(', ')}`);
  output.push(`${encoded.join(' ')} @${label}`);
}
if (!output.length) throw new Error('At least one keyword is required.');
await writeFile(outputPath, `${output.join('\n')}\n`, 'utf8');

function encodePhrase(phrase, lexicon) {
  const result = [];
  for (const part of phrase.match(/[A-Za-z][A-Za-z'-]*|[\p{Script=Han}]/gu) ?? []) {
    if (/^[A-Za-z]/u.test(part)) {
      const key = part.toUpperCase();
      const phones = lexicon.get(key) ?? BUILTIN_ENGLISH.get(key);
      if (!phones) throw new Error(`English keyword is not present in the bundled pronunciation lexicon: ${part}`);
      result.push(...phones);
      continue;
    }
    const initial = pinyin(part, { pattern: 'initial', type: 'array' })[0] ?? '';
    let final = pinyin(part, { pattern: 'final', toneType: 'symbol', type: 'array' })[0] ?? '';
    if (['j', 'q', 'x', 'y'].includes(initial)) final = final.replaceAll('ü', 'u');
    if (initial) result.push(initial);
    if (final) result.push(final);
  }
  if (!result.length) throw new Error(`Keyword contains no supported Chinese or English text: ${phrase}`);
  return result;
}

function parseLexicon(text) {
  const result = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 2) continue;
    const word = parts.shift().replace(/\(\d+\)$/u, '').toUpperCase();
    if (!result.has(word)) result.set(word, parts);
  }
  return result;
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
