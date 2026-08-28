import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceFileService } from '../src/main/services/workspace-file-service';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('workspace file service', () => {
  it('returns relative projections and reads nested directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ariadne-workspace-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(root, 'src', 'index.ts'), 'export {};');
    const service = new WorkspaceFileService([{ workspaceId: 'workspace-main', rootPath: root }]);
    const rootListing = await service.listDirectory({ workspaceId: 'workspace-main', relativePath: '' });
    expect(rootListing.entries).toEqual([
      { name: 'src', relativePath: 'src', type: 'directory' },
      { name: 'package.json', relativePath: 'package.json', type: 'file' }
    ]);
    expect(rootListing.workspaceId).toBe('workspace-main');
    expect((await service.listDirectory({ workspaceId: 'workspace-main', relativePath: 'src' })).entries[0]).toEqual({
      name: 'index.ts', relativePath: 'src/index.ts', type: 'file'
    });
    expect(JSON.stringify(rootListing)).not.toContain(root);
  });

  it('requires an absolute configured root', () => {
    expect(() => new WorkspaceFileService([
      { workspaceId: 'workspace-main', rootPath: 'relative/path' }
    ])).toThrow('absolute paths');
  });

  it('resolves each authorized workspace by explicit identifier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ariadne-workspace-switch-'));
    const next = join(root, 'next');
    await mkdir(next);
    roots.push(root);
    const service = new WorkspaceFileService([
      { workspaceId: 'workspace-main', rootPath: root },
      { workspaceId: 'secondary', rootPath: next }
    ]);
    expect(service.getRoot('workspace-main')).toBe(root);
    expect(service.getRoot('secondary')).toBe(next);
    expect((await service.listDirectory({ workspaceId: 'secondary', relativePath: '' }))).toMatchObject({
      workspaceId: 'secondary',
      rootLabel: 'next'
    });
    await expect(service.listDirectory({ workspaceId: 'unknown', relativePath: '' })).rejects.toThrow(
      'Workspace is not authorized.'
    );
  });

  it('rejects a directly requested directory link that resolves outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ariadne-workspace-link-'));
    const outside = await mkdtemp(join(tmpdir(), 'ariadne-workspace-outside-'));
    roots.push(root, outside);
    await writeFile(join(outside, 'secret.txt'), 'not workspace data');
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const service = new WorkspaceFileService([{ workspaceId: 'workspace-main', rootPath: root }]);

    await expect(service.listDirectory({ workspaceId: 'workspace-main', relativePath: 'escape' })).rejects.toThrow(
      'Workspace path escapes the configured root.'
    );
  });

  it('rejects duplicate workspace identities and roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ariadne-workspace-duplicates-'));
    const next = join(root, 'next');
    roots.push(root);
    expect(() => new WorkspaceFileService([
      { workspaceId: 'workspace-main', rootPath: root },
      { workspaceId: 'workspace-main', rootPath: next }
    ])).toThrow('duplicate identifier');
    expect(() => new WorkspaceFileService([
      { workspaceId: 'workspace-main', rootPath: root },
      { workspaceId: 'secondary', rootPath: root }
    ])).toThrow('duplicate root');
  });

  it('does not expose absolute paths when an authorized directory becomes unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ariadne-workspace-unavailable-'));
    roots.push(root);
    const service = new WorkspaceFileService([{ workspaceId: 'workspace-main', rootPath: root }]);
    await rm(root, { recursive: true, force: true });

    const failure = await service.listDirectory({ workspaceId: 'workspace-main', relativePath: '' })
      .then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Workspace directory is unavailable.');
    expect((failure as Error).message).not.toContain(root);
  });
});
