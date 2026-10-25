import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}
const failures = [];
for (const file of [path.join(root, 'README.md'), path.join(root, 'runtime/README.md'), ...walk(path.join(root, 'docs'))]) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/gu)) {
    const link = match[1].split('#')[0];
    if (!link || /^[a-z][a-z\d+.-]*:/iu.test(link)) continue;
    const target = path.resolve(path.dirname(file), decodeURIComponent(link));
    if (!existsSync(target)) failures.push(`${path.relative(root, file)}: ${link}`);
  }
}
if (failures.length) throw new Error(`documentation_links_missing:\n${failures.join('\n')}`);
console.log('Documentation file links verified.');
