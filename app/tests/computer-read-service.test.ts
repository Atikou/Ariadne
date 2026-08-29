import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComputerReadService } from '../src/main/services/computer-read-service';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true
  })));
});

describe('ComputerReadService', () => {
  it('lists and reads absolute paths anywhere allowed by the operating system', async () => {
    const root = await createTemporaryRoot();
    const childDirectory = join(root, 'folder');
    const textPath = join(root, 'notes.txt');
    await mkdir(childDirectory);
    await writeFile(textPath, '只读内容', 'utf8');
    const canonicalRoot = await realpath(root);
    const canonicalTextPath = await realpath(textPath);
    const service = new ComputerReadService(async () => '');

    await expect(service.handle({
      kind: 'computer.list_directory',
      path: root
    })).resolves.toMatchObject({
      path: canonicalRoot,
      entries: [
        { name: 'folder', kind: 'directory' },
        { name: 'notes.txt', kind: 'file' }
      ],
      truncated: false
    });
    await expect(service.handle({
      kind: 'computer.read_text_file',
      path: textPath
    })).resolves.toMatchObject({
      path: canonicalTextPath,
      content: '只读内容'
    });
  });

  it('requires an explicit absolute path', async () => {
    const service = new ComputerReadService(async () => '');

    await expect(service.handle({
      kind: 'computer.read_text_file',
      path: 'notes.txt'
    })).rejects.toThrow('computer_absolute_path_required');
  });

  it('opens readable files through the Main-owned desktop operation', async () => {
    const root = await createTemporaryRoot();
    const textPath = join(root, 'notes.txt');
    await writeFile(textPath, 'content', 'utf8');
    const canonicalTextPath = await realpath(textPath);
    const revealReadablePath = vi.fn(async () => '');
    const service = new ComputerReadService(revealReadablePath);

    await expect(service.handle({
      kind: 'computer.open_path',
      path: textPath
    })).resolves.toEqual({
      path: canonicalTextPath,
      opened: true
    });
    expect(revealReadablePath).toHaveBeenCalledWith(canonicalTextPath);
  });

  it('never launches executable or script files', async () => {
    const root = await createTemporaryRoot();
    const scriptPath = join(root, 'run.cmd');
    await writeFile(scriptPath, '@echo off', 'utf8');
    const revealReadablePath = vi.fn(async () => '');
    const service = new ComputerReadService(revealReadablePath);

    await expect(service.handle({
      kind: 'computer.open_path',
      path: scriptPath
    })).rejects.toThrow('computer_executable_open_denied');
    expect(revealReadablePath).not.toHaveBeenCalled();
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ariadne-computer-read-'));
  temporaryRoots.push(root);
  return root;
}
