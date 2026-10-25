import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packages = new Map([
  ['runtime', 'runtime'], ['protocol', 'packages/protocol'], ['agent-core', 'packages/agent-core'],
  ['component-contracts', 'packages/component-contracts'], ['live-work', 'packages/live-work']
]);
const directory = packages.get(process.argv[2]);
if (!directory || process.argv.length !== 3) throw new Error('typescript_output_owner_invalid');
const owner = path.resolve(root, directory);
const output = path.resolve(owner, 'dist');
if (path.dirname(output) !== owner || !owner.startsWith(root + path.sep)) throw new Error('typescript_output_path_invalid');
if (existsSync(output)) {
  if (lstatSync(output).isSymbolicLink() || realpathSync(output).toLowerCase() !== output.toLowerCase()) {
    throw new Error('typescript_output_must_be_owned_directory');
  }
  rmSync(output, { recursive: true, force: true });
}
