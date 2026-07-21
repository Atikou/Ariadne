import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
    const service = new WorkspaceFileService(root);
    const rootListing = await service.listDirectory({ relativePath: '' });
    expect(rootListing.entries).toEqual([
      { name: 'src', relativePath: 'src', type: 'directory' },
      { name: 'package.json', relativePath: 'package.json', type: 'file' }
    ]);
    expect((await service.listDirectory({ relativePath: 'src' })).entries[0]).toEqual({
      name: 'index.ts', relativePath: 'src/index.ts', type: 'file'
    });
    expect(JSON.stringify(rootListing)).not.toContain(root);
  });

  it('requires an absolute configured root', () => {
    expect(() => new WorkspaceFileService('relative/path')).toThrow('absolute path');
  });
});
