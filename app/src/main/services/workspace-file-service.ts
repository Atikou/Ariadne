import { mkdirSync, realpathSync } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkspaceDirectoryListing, WorkspaceDirectoryRequest } from '@shared/contract';

const MAX_ENTRIES = 2_000;
const MAX_WORKSPACES = 32;

export interface WorkspaceFileRoot {
  workspaceId: string;
  rootPath: string;
}

interface AuthorizedWorkspaceRoot {
  rootPath: string;
  canonicalRoot: string;
}

class WorkspaceFileBoundaryError extends Error {}

export class WorkspaceFileService {
  private roots = new Map<string, AuthorizedWorkspaceRoot>();

  constructor(workspaces: readonly WorkspaceFileRoot[]) {
    this.setWorkspaces(workspaces);
  }

  setWorkspaces(workspaces: readonly WorkspaceFileRoot[]): void {
    if (workspaces.length < 1 || workspaces.length > MAX_WORKSPACES) {
      throw new Error('Workspace catalog must contain between 1 and 32 entries.');
    }
    if (!workspaces.some((workspace) => workspace.workspaceId === 'primary')) {
      throw new Error('Workspace catalog must contain the primary workspace.');
    }

    const identities = new Set<string>();
    const lexicalRoots = new Set<string>();
    for (const workspace of workspaces) {
      const workspaceId = workspace.workspaceId.trim();
      if (!workspaceId || workspaceId.length > 128 || identities.has(workspaceId)) {
        throw new Error('Workspace catalog contains an invalid or duplicate identifier.');
      }
      if (!isAbsolute(workspace.rootPath)) {
        throw new Error('Workspace roots must use absolute paths.');
      }
      const rootPath = resolve(workspace.rootPath);
      const lexicalIdentity = pathIdentity(rootPath);
      if (lexicalRoots.has(lexicalIdentity)) {
        throw new Error('Workspace catalog contains a duplicate root.');
      }
      identities.add(workspaceId);
      lexicalRoots.add(lexicalIdentity);
    }

    const next = new Map<string, AuthorizedWorkspaceRoot>();
    const canonicalRoots = new Set<string>();
    for (const workspace of workspaces) {
      const rootPath = resolve(workspace.rootPath);
      mkdirSync(rootPath, { recursive: true });
      const canonicalRoot = realpathSync.native(rootPath);
      const canonicalIdentity = pathIdentity(canonicalRoot);
      if (canonicalRoots.has(canonicalIdentity)) {
        throw new Error('Workspace catalog resolves multiple entries to the same directory.');
      }
      canonicalRoots.add(canonicalIdentity);
      next.set(workspace.workspaceId.trim(), { rootPath, canonicalRoot });
    }
    this.roots = next;
  }

  getRoot(workspaceId: string): string {
    return this.requireWorkspace(workspaceId).rootPath;
  }

  async listDirectory(request: WorkspaceDirectoryRequest): Promise<WorkspaceDirectoryListing> {
    try {
      const workspace = this.requireWorkspace(request.workspaceId);
      const target = resolve(
        workspace.rootPath,
        ...request.relativePath.split('/').filter(Boolean)
      );
      assertPathInside(workspace.rootPath, target);
      const canonicalTarget = await realpath(target);
      assertPathInside(workspace.canonicalRoot, canonicalTarget);
      const entries = (await readdir(canonicalTarget, { withFileTypes: true }))
        .filter((entry) => !entry.isSymbolicLink() && (entry.isDirectory() || entry.isFile()))
        .map((entry) => ({
          name: entry.name,
          relativePath: request.relativePath ? `${request.relativePath}/${entry.name}` : entry.name,
          type: entry.isDirectory() ? 'directory' as const : 'file' as const
        }))
        .sort((left, right) => left.type === right.type
          ? left.name.localeCompare(right.name)
          : left.type === 'directory' ? -1 : 1)
        .slice(0, MAX_ENTRIES);
      return {
        workspaceId: request.workspaceId,
        rootLabel: basename(workspace.rootPath) || request.workspaceId,
        relativePath: request.relativePath,
        entries
      };
    } catch (error) {
      if (error instanceof WorkspaceFileBoundaryError) throw error;
      throw new WorkspaceFileBoundaryError('Workspace directory is unavailable.');
    }
  }

  private requireWorkspace(workspaceId: string): AuthorizedWorkspaceRoot {
    const workspace = this.roots.get(workspaceId);
    if (!workspace) throw new WorkspaceFileBoundaryError('Workspace is not authorized.');
    return workspace;
  }
}

function assertPathInside(root: string, target: string): void {
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === '') return;
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new WorkspaceFileBoundaryError('Workspace path escapes the configured root.');
  }
}

function pathIdentity(value: string): string {
  return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
}
