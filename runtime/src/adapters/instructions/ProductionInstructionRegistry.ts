import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

export interface InstructionBlock {
  readonly authority: 'workspace_root' | 'target_directory';
  readonly source: string;
  readonly text: string;
}

export class WorkspaceInstructionLoader {
  public resolve(workspaceRoot: string, targetDirectory?: string): InstructionBlock[] {
    const root = canonical(workspaceRoot);
    const target = canonical(targetDirectory ?? root);
    if (!isWithin(root, target)) throw new Error('instruction_target_outside_workspace');
    const directories: string[] = [];
    let cursor = target;
    while (true) {
      directories.push(cursor);
      if (samePath(cursor, root)) break;
      cursor = path.dirname(cursor);
    }
    directories.reverse();
    const blocks: InstructionBlock[] = [];
    for (const [index, directory] of directories.entries()) {
      for (const fileName of ['.ariadne/INSTRUCTIONS.md', 'AGENTS.md']) {
        const filePath = path.join(directory, fileName);
        if (!existsSync(filePath)) continue;
        const canonicalFile = realpathSync(filePath);
        if (!isWithin(root, canonicalFile)) {
          throw new Error(`instruction_path_outside_workspace:${fileName}`);
        }
        blocks.push({
          authority: index === 0 ? 'workspace_root' : 'target_directory',
          source: path.relative(root, filePath).replace(/\\/gu, '/') || fileName,
          text: readBoundedText(canonicalFile, 128 * 1024)
        });
      }
    }
    return blocks;
  }
}

export function renderInstructionBlocks(blocks: readonly InstructionBlock[]): string {
  return blocks.map((block) => [
    `[INSTRUCTION authority=${block.authority} source=${block.source}]`,
    block.text,
    '[/INSTRUCTION]'
  ].join('\n')).join('\n\n');
}

function readBoundedText(filePath: string, maxBytes: number): string {
  const content = readFileSync(filePath);
  if (content.byteLength > maxBytes) throw new Error(`instruction_file_too_large:${filePath}`);
  if (content.includes(0)) throw new Error(`instruction_file_binary:${filePath}`);
  return content.toString('utf8');
}

function canonical(value: string): string {
  const resolved = path.resolve(value);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
