import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';

import type { ComputerReadCapabilityOperation } from '@ariadne/protocol/host';

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 2_000;
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([
  '.bat', '.cmd', '.com', '.cpl', '.exe', '.hta', '.jar', '.js', '.jse', '.lnk',
  '.msc', '.msi', '.msp', '.ps1', '.psd1', '.psm1', '.reg', '.scr', '.url',
  '.vbe', '.vbs', '.wsf', '.wsh'
]);

export class ComputerReadService {
  public constructor(
    private readonly revealReadablePath: (path: string) => Promise<string>
  ) {}

  public async handle(
    operation: ComputerReadCapabilityOperation
  ): Promise<Record<string, unknown>> {
    switch (operation.kind) {
      case 'computer.list_directory':
        return this.listDirectory(operation.path);
      case 'computer.read_text_file':
        return this.readTextFile(operation.path);
      case 'computer.open_path':
        return this.openReadablePath(operation.path);
    }
  }

  private async listDirectory(inputPath: string): Promise<Record<string, unknown>> {
    const canonicalPath = await canonicalAbsolutePath(inputPath);
    const metadata = await stat(canonicalPath);
    if (!metadata.isDirectory()) throw new Error('computer_path_not_directory');
    const entries = await readdir(canonicalPath, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    const bounded = entries.slice(0, MAX_DIRECTORY_ENTRIES).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
    }));
    return {
      path: canonicalPath,
      entries: bounded,
      truncated: entries.length > bounded.length
    };
  }

  private async readTextFile(inputPath: string): Promise<Record<string, unknown>> {
    const canonicalPath = await canonicalAbsolutePath(inputPath);
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) throw new Error('computer_path_not_file');
    if (metadata.size > MAX_TEXT_BYTES) throw new Error('computer_file_exceeds_read_limit');
    const bytes = await readFile(canonicalPath);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { path: canonicalPath, content, byteLength: bytes.byteLength };
  }

  private async openReadablePath(inputPath: string): Promise<Record<string, unknown>> {
    const canonicalPath = await canonicalAbsolutePath(inputPath);
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile() && !metadata.isDirectory()) {
      throw new Error('computer_path_not_openable');
    }
    if (metadata.isFile() && isExecutablePath(canonicalPath, metadata.mode)) {
      throw new Error('computer_executable_open_denied');
    }
    const error = await this.revealReadablePath(canonicalPath);
    if (error) throw new Error(`computer_open_failed:${error}`);
    return { path: canonicalPath, opened: true };
  }
}

async function canonicalAbsolutePath(inputPath: string): Promise<string> {
  if (!isAbsolute(inputPath)) throw new Error('computer_absolute_path_required');
  return realpath(resolve(inputPath));
}

function isExecutablePath(filePath: string, mode: number): boolean {
  if (process.platform === 'win32') {
    return WINDOWS_EXECUTABLE_EXTENSIONS.has(extname(filePath).toLocaleLowerCase('en-US'));
  }
  return (mode & 0o111) !== 0;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
