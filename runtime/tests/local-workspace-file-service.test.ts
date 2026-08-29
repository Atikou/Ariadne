import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LocalWorkspaceFileError,
  LocalWorkspaceFileService
} from '../src/adapters/filesystem/LocalWorkspaceFileService.js';

const temporaryRoots: string[] = [];
const signal = new AbortController().signal;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('LocalWorkspaceFileService', () => {
  it('publishes new files without replacing an existing target', async () => {
    const root = temporaryRoot();
    const target = path.join(root, 'notes', 'new.txt');
    const service = new LocalWorkspaceFileService();

    await expect(service.writeText({
      absolutePath: target,
      content: 'first',
      expected: { kind: 'create_if_absent' },
      maxBytes: 1_024,
      signal
    })).resolves.toMatchObject({
      operation: 'created',
      byteLength: 5,
      version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
    });
    expect(readFileSync(target, 'utf8')).toBe('first');

    await expect(service.writeText({
      absolutePath: target,
      content: 'second',
      expected: { kind: 'create_if_absent' },
      maxBytes: 1_024,
      signal
    })).rejects.toMatchObject<Partial<LocalWorkspaceFileError>>({
      code: 'workspace_file_already_exists'
    });
    expect(readFileSync(target, 'utf8')).toBe('first');
    expect(temporaryArtifacts(path.dirname(target))).toEqual([]);
  });

  it('returns an opaque version and rejects a replacement after an external edit', async () => {
    const root = temporaryRoot();
    const target = path.join(root, 'note.txt');
    writeFileSync(target, 'observed', 'utf8');
    const service = new LocalWorkspaceFileService();
    const observed = await service.readText({
      absolutePath: target,
      maxBytes: 1_024,
      signal
    });
    expect(observed).toMatchObject({
      content: 'observed',
      byteLength: 8,
      version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
    });

    writeFileSync(target, 'external', 'utf8');
    await expect(service.writeText({
      absolutePath: target,
      content: 'agent',
      expected: { kind: 'replace_if_version', version: observed.version },
      maxBytes: 1_024,
      signal
    })).rejects.toMatchObject<Partial<LocalWorkspaceFileError>>({
      code: 'workspace_file_stale_version'
    });
    expect(readFileSync(target, 'utf8')).toBe('external');
    expect(temporaryArtifacts(root)).toEqual([]);
  });

  it('atomically replaces exactly the observed version', async () => {
    const root = temporaryRoot();
    const target = path.join(root, 'note.txt');
    writeFileSync(target, 'before', 'utf8');
    const service = new LocalWorkspaceFileService();
    const observed = await service.readText({
      absolutePath: target,
      maxBytes: 1_024,
      signal
    });

    const written = await service.writeText({
      absolutePath: target,
      content: 'after',
      expected: { kind: 'replace_if_version', version: observed.version },
      maxBytes: 1_024,
      signal
    });
    expect(written).toMatchObject({
      operation: 'replaced',
      byteLength: 5,
      version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
    });
    expect(written.version).not.toBe(observed.version);
    expect(readFileSync(target, 'utf8')).toBe('after');
    expect(temporaryArtifacts(root)).toEqual([]);
  });

  it('treats deletion after observation as a stale replacement', async () => {
    const root = temporaryRoot();
    const target = path.join(root, 'note.txt');
    writeFileSync(target, 'before', 'utf8');
    const service = new LocalWorkspaceFileService();
    const observed = await service.readText({
      absolutePath: target,
      maxBytes: 1_024,
      signal
    });
    rmSync(target);

    await expect(service.writeText({
      absolutePath: target,
      content: 'must-not-recreate',
      expected: { kind: 'replace_if_version', version: observed.version },
      maxBytes: 1_024,
      signal
    })).rejects.toMatchObject<Partial<LocalWorkspaceFileError>>({
      code: 'workspace_file_stale_version'
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it('allows only one of two concurrent replacements from the same observation', async () => {
    const root = temporaryRoot();
    const target = path.join(root, 'note.txt');
    writeFileSync(target, 'before', 'utf8');
    const service = new LocalWorkspaceFileService();
    const observed = await service.readText({
      absolutePath: target,
      maxBytes: 1_024,
      signal
    });
    const outcomes = await Promise.allSettled(['left', 'right'].map((content) =>
      service.writeText({
        absolutePath: target,
        content,
        expected: { kind: 'replace_if_version', version: observed.version },
        maxBytes: 1_024,
        signal
      })
    ));

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { code: 'workspace_file_stale_version' }
    });
    expect(['left', 'right']).toContain(readFileSync(target, 'utf8'));
    expect(temporaryArtifacts(root)).toEqual([]);
  });

  it('does not publish when cancellation is already requested', async () => {
    const root = temporaryRoot();
    const target = path.join(root, 'cancelled.txt');
    const controller = new AbortController();
    controller.abort();
    const service = new LocalWorkspaceFileService();

    await expect(service.writeText({
      absolutePath: target,
      content: 'never-visible',
      expected: { kind: 'create_if_absent' },
      maxBytes: 1_024,
      signal: controller.signal
    })).rejects.toMatchObject<Partial<LocalWorkspaceFileError>>({
      code: 'workspace_file_aborted'
    });
    expect(readdirSync(root)).toEqual([]);
  });

  it('applies one-based Unicode text edits through the same atomic version owner', async () => {
    const root = temporaryRoot();
    const target = path.join(root, 'unicode.txt');
    writeFileSync(target, 'alpha 🧭\r\nbeta\n', 'utf8');
    const service = new LocalWorkspaceFileService();
    const observed = await service.readText({
      absolutePath: target,
      maxBytes: 1_024,
      signal
    });

    const edited = await service.editText({
      absolutePath: target,
      expectedVersion: observed.version,
      edits: [{
        start: { line: 2, column: 5 },
        end: { line: 2, column: 5 },
        text: '!'
      }, {
        start: { line: 1, column: 7 },
        end: { line: 1, column: 8 },
        text: 'compass'
      }],
      maxBytes: 1_024,
      signal
    });

    expect(edited).toMatchObject({
      operation: 'edited',
      appliedEdits: 2,
      version: expect.stringMatching(/^workspace-file-v1:[a-f0-9]{64}$/u)
    });
    expect(edited.version).not.toBe(observed.version);
    expect(readFileSync(target, 'utf8')).toBe('alpha compass\r\nbeta!\n');
    expect(temporaryArtifacts(root)).toEqual([]);
  });

  it('rejects overlapping edits without publishing partial content', async () => {
    const root = temporaryRoot();
    const target = path.join(root, 'overlap.txt');
    writeFileSync(target, 'abcdef', 'utf8');
    const service = new LocalWorkspaceFileService();
    const observed = await service.readText({
      absolutePath: target,
      maxBytes: 1_024,
      signal
    });

    await expect(service.editText({
      absolutePath: target,
      expectedVersion: observed.version,
      edits: [{
        start: { line: 1, column: 2 },
        end: { line: 1, column: 5 },
        text: 'left'
      }, {
        start: { line: 1, column: 4 },
        end: { line: 1, column: 6 },
        text: 'right'
      }],
      maxBytes: 1_024,
      signal
    })).rejects.toMatchObject<Partial<LocalWorkspaceFileError>>({
      code: 'workspace_file_edit_overlap'
    });
    expect(readFileSync(target, 'utf8')).toBe('abcdef');
    expect(temporaryArtifacts(root)).toEqual([]);
  });

  it('serializes edits with whole-file replacement under one freshness lock', async () => {
    const root = temporaryRoot();
    const target = path.join(root, 'concurrent-edit.txt');
    writeFileSync(target, 'before', 'utf8');
    const service = new LocalWorkspaceFileService();
    const observed = await service.readText({
      absolutePath: target,
      maxBytes: 1_024,
      signal
    });
    const outcomes = await Promise.allSettled([
      service.editText({
        absolutePath: target,
        expectedVersion: observed.version,
        edits: [{
          start: { line: 1, column: 1 },
          end: { line: 1, column: 7 },
          text: 'edited'
        }],
        maxBytes: 1_024,
        signal
      }),
      service.writeText({
        absolutePath: target,
        content: 'replaced',
        expected: { kind: 'replace_if_version', version: observed.version },
        maxBytes: 1_024,
        signal
      })
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toMatchObject([{
      reason: { code: 'workspace_file_stale_version' }
    }]);
    expect(['edited', 'replaced']).toContain(readFileSync(target, 'utf8'));
    expect(temporaryArtifacts(root)).toEqual([]);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-workspace-file-'));
  temporaryRoots.push(root);
  return root;
}

function temporaryArtifacts(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.includes('.ariadne-'));
}
