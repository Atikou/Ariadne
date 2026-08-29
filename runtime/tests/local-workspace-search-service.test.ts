import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalWorkspaceFileService } from '../src/adapters/filesystem/LocalWorkspaceFileService.js';
import {
  LocalWorkspaceSearchError,
  LocalWorkspaceSearchService
} from '../src/adapters/filesystem/LocalWorkspaceSearchService.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('LocalWorkspaceSearchService', () => {
  it('finds bounded literal text with stable file versions and Unicode columns', async () => {
    const root = fixtureRoot();
    write('src/a.ts', 'const value = "Needle";\n🧭 needle here\n');
    write('src/nested/b.ts', 'export const needle = true;\n');
    write('src/nested/skip.js', 'needle\n');
    const service = new LocalWorkspaceSearchService(new LocalWorkspaceFileService());

    const result = await service.searchText({
      workspaceRoot: root,
      absoluteDirectory: path.join(root, 'src'),
      query: 'needle',
      caseSensitive: false,
      includeGlob: '**/*.ts',
      excludeGlobs: [],
      bounds: {
        maxResults: 20,
        maxFiles: 100,
        maxTotalBytes: 1024 * 1024,
        maxFileBytes: 64 * 1024
      },
      signal: new AbortController().signal
    });

    expect(result).toMatchObject({
      scannedFiles: 2,
      skippedFiles: 0,
      truncated: false,
      matches: [{
        path: 'src/a.ts',
        line: 1,
        column: 16,
        version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
      }, {
        path: 'src/a.ts',
        line: 2,
        column: 3,
        version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
      }, {
        path: 'src/nested/b.ts',
        line: 1,
        column: 14,
        version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
      }]
    });
  });

  it('returns deterministic glob results and applies bounded exclusions', async () => {
    const root = fixtureRoot();
    write('a.ts', 'a');
    write('src/b.ts', 'b');
    write('src/generated/c.ts', 'c');
    write('src/z.txt', 'z');
    const service = new LocalWorkspaceSearchService(new LocalWorkspaceFileService());

    await expect(service.glob({
      workspaceRoot: root,
      absoluteDirectory: root,
      pattern: '**/*.ts',
      excludeGlobs: ['**/generated/**'],
      maxResults: 20,
      maxEntries: 100,
      signal: new AbortController().signal
    })).resolves.toEqual({
      matches: [
        { path: 'a.ts', kind: 'file' },
        { path: 'src/b.ts', kind: 'file' }
      ],
      scannedEntries: 4,
      truncated: false
    });
  });

  it('skips non-text files and reports result truncation without unbounded reads', async () => {
    const root = fixtureRoot();
    write('binary.bin', Buffer.from([0xff, 0xfe, 0xfd]));
    write('many.txt', 'hit hit hit\n');
    const service = new LocalWorkspaceSearchService(new LocalWorkspaceFileService());

    const result = await service.searchText({
      workspaceRoot: root,
      absoluteDirectory: root,
      query: 'hit',
      caseSensitive: true,
      includeGlob: '**/*',
      excludeGlobs: [],
      bounds: {
        maxResults: 2,
        maxFiles: 10,
        maxTotalBytes: 1_024,
        maxFileBytes: 1_024
      },
      signal: new AbortController().signal
    });

    expect(result.matches).toHaveLength(2);
    expect(result.skippedFiles).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('rejects traversal outside the authorized root and pre-start cancellation', async () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    const service = new LocalWorkspaceSearchService(new LocalWorkspaceFileService());
    await expect(service.glob({
      workspaceRoot: root,
      absoluteDirectory: outside,
      pattern: '**/*',
      excludeGlobs: [],
      maxResults: 10,
      maxEntries: 10,
      signal: new AbortController().signal
    })).rejects.toMatchObject<Partial<LocalWorkspaceSearchError>>({
      code: 'workspace_search_boundary_invalid'
    });

    const controller = new AbortController();
    controller.abort();
    await expect(service.searchText({
      workspaceRoot: root,
      absoluteDirectory: root,
      query: 'anything',
      caseSensitive: true,
      includeGlob: '**/*',
      excludeGlobs: [],
      bounds: {
        maxResults: 10,
        maxFiles: 10,
        maxTotalBytes: 1_024,
        maxFileBytes: 1_024
      },
      signal: controller.signal
    })).rejects.toMatchObject<Partial<LocalWorkspaceSearchError>>({
      code: 'workspace_search_aborted'
    });
  });

  function fixtureRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-workspace-search-'));
    temporaryRoots.push(root);
    return root;
  }

  function write(relativePath: string, content: string | Buffer): void {
    const root = temporaryRoots.at(-1);
    if (root === undefined) throw new Error('workspace_search_fixture_root_missing');
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
});
