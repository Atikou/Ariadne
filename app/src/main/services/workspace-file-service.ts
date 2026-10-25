import { realpathSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkspaceDirectoryListing, WorkspaceDirectoryRequest } from '@shared/contract';
import { fileDraftPathRequestSchema, fileDraftPathResultSchema } from '@shared/file-drafts';

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
    if (workspaces.length > MAX_WORKSPACES) throw new Error('Workspace catalog cannot exceed 32 entries.');

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

  /** Read-only identity resolution. Existing paths retain actual filesystem
   * case; only not-yet-existing Windows suffixes share a comparison namespace. */
  async resolveDocumentPath(input: {workspaceId:string;path:string}) {
    const request=fileDraftPathRequestSchema.parse(input),workspace=this.requireWorkspace(request.workspaceId);
    try {
      const rootReal=await realpath(workspace.rootPath);
      if(pathIdentity(rootReal)!==pathIdentity(workspace.canonicalRoot))throw new WorkspaceFileBoundaryError('Workspace root identity changed.');
      let cursor=resolve(workspace.rootPath,...request.path.split('/'));
      assertPathInside(workspace.rootPath,cursor);
      const missing:string[]=[];
      for (;;) {
        try {
          const canonical=await realpath(cursor);assertPathInside(workspace.canonicalRoot,canonical);
          const observed=await stat(canonical);
          if(!missing.length&&(!observed.isFile()||observed.nlink>1))throw new WorkspaceFileBoundaryError('Only regular files with one filesystem link can be edited.');
          if(missing.length&&!observed.isDirectory())throw new WorkspaceFileBoundaryError('File parent is not a directory.');
          const prefix=relative(workspace.canonicalRoot,canonical).split(sep).join('/');
          const path=[prefix,...missing].filter(Boolean).join('/');
          const comparisonPath=[prefix,...missing.map(part=>process.platform==='win32'?part.toLowerCase():part)].filter(Boolean).join('/');
          return fileDraftPathResultSchema.parse({workspaceId:request.workspaceId,path,comparisonPath,exists:missing.length===0});
        }catch(error){
          if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;
          if(pathIdentity(cursor)===pathIdentity(workspace.rootPath))throw error;
          missing.unshift(basename(cursor));const parent=dirname(cursor);if(parent===cursor)throw error;cursor=parent;
        }
      }
    }catch(error){if(error instanceof WorkspaceFileBoundaryError)throw error;throw new WorkspaceFileBoundaryError('Workspace file identity is unavailable.');}
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
