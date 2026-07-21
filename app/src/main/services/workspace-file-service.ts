import { readdir } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkspaceDirectoryListing, WorkspaceDirectoryRequest } from '@shared/contract';

const MAX_ENTRIES = 2_000;

export class WorkspaceFileService {
  private readonly root: string;

  constructor(configuredRoot = process.env.ARIADNE_WORKSPACE_ROOT ?? process.cwd()) {
    if (!isAbsolute(configuredRoot)) throw new Error('ARIADNE_WORKSPACE_ROOT must be an absolute path.');
    this.root = resolve(configuredRoot);
  }

  async listDirectory(request: WorkspaceDirectoryRequest): Promise<WorkspaceDirectoryListing> {
    const target = resolve(this.root, ...request.relativePath.split('/').filter(Boolean));
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) {
      throw new Error('Workspace path escapes the configured root.');
    }
    const entries = await readdir(target, { withFileTypes: true });
    const projected = entries
      .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
      .slice(0, MAX_ENTRIES)
      .map((entry) => {
        const absolutePath = resolve(target, entry.name);
        return {
          name: entry.name,
          relativePath: relative(this.root, absolutePath).split(sep).join('/'),
          type: entry.isDirectory() ? 'directory' as const : 'file' as const
        };
      })
      .sort((left, right) => left.type === right.type
        ? left.name.localeCompare(right.name)
        : left.type === 'directory' ? -1 : 1);
    return {
      rootLabel: basename(this.root),
      relativePath: request.relativePath,
      entries: projected
    };
  }
}
