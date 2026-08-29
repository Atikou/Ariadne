import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { WorkspaceFileService } from '../../control/ports/WorkspaceFileService.js';
import type {
  WorkspaceGlobMatch,
  WorkspaceGlobOutcome,
  WorkspaceSearchBounds,
  WorkspaceSearchService,
  WorkspaceTextSearchMatch,
  WorkspaceTextSearchOutcome
} from '../../control/ports/WorkspaceSearchService.js';
import { LocalWorkspaceFileError } from './LocalWorkspaceFileService.js';

export type LocalWorkspaceSearchErrorCode =
  | 'workspace_search_aborted'
  | 'workspace_search_boundary_invalid'
  | 'workspace_search_glob_invalid'
  | 'workspace_search_input_invalid'
  | 'workspace_search_io_error';

export class LocalWorkspaceSearchError extends Error {
  constructor(readonly code: LocalWorkspaceSearchErrorCode) {
    super(code);
    this.name = 'LocalWorkspaceSearchError';
  }
}

interface TraversedEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly kind: 'file' | 'directory';
}

/** Bounded literal search and glob discovery; no shell or external executable. */
export class LocalWorkspaceSearchService implements WorkspaceSearchService {
  constructor(private readonly files: WorkspaceFileService) {}

  async searchText(input: {
    readonly workspaceRoot: string;
    readonly absoluteDirectory: string;
    readonly query: string;
    readonly caseSensitive: boolean;
    readonly includeGlob: string;
    readonly excludeGlobs: readonly string[];
    readonly bounds: WorkspaceSearchBounds;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextSearchOutcome> {
    assertSearchInput(input.query, input.bounds);
    const include = compileGlob(input.includeGlob);
    const excludes = input.excludeGlobs.map(compileGlob);
    const entries = await traverseWorkspace({
      workspaceRoot: input.workspaceRoot,
      absoluteDirectory: input.absoluteDirectory,
      exclude: excludes,
      maxEntries: input.bounds.maxFiles,
      signal: input.signal
    });
    const expression = new RegExp(escapeRegExp(input.query), input.caseSensitive ? 'gu' : 'giu');
    const matches: WorkspaceTextSearchMatch[] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    let skippedFiles = 0;
    let truncated = entries.truncated;
    for (const entry of entries.items) {
      assertNotAborted(input.signal);
      if (entry.kind !== 'file' || !include.test(entry.relativePath)) continue;
      if (scannedFiles >= input.bounds.maxFiles || scannedBytes >= input.bounds.maxTotalBytes) {
        truncated = true;
        break;
      }
      try {
        const read = await this.files.readText({
          absolutePath: entry.absolutePath,
          maxBytes: Math.min(
            input.bounds.maxFileBytes,
            input.bounds.maxTotalBytes - scannedBytes
          ),
          signal: input.signal
        });
        scannedFiles += 1;
        scannedBytes += read.byteLength;
        for (const line of textLines(read.content)) {
          expression.lastIndex = 0;
          for (let found = expression.exec(line.text); found !== null; found = expression.exec(line.text)) {
            matches.push({
              path: entry.relativePath,
              line: line.number,
              column: Array.from(line.text.slice(0, found.index)).length + 1,
              preview: boundedPreview(line.text, 512),
              version: read.version
            });
            if (matches.length >= input.bounds.maxResults) {
              truncated = true;
              return { matches, scannedFiles, scannedBytes, skippedFiles, truncated };
            }
          }
        }
      } catch (error) {
        if (isSkippableFileError(error)) {
          skippedFiles += 1;
          continue;
        }
        if (error instanceof LocalWorkspaceFileError && error.code === 'workspace_file_aborted') {
          throw new LocalWorkspaceSearchError('workspace_search_aborted');
        }
        throw new LocalWorkspaceSearchError('workspace_search_io_error');
      }
    }
    return { matches, scannedFiles, scannedBytes, skippedFiles, truncated };
  }

  async glob(input: {
    readonly workspaceRoot: string;
    readonly absoluteDirectory: string;
    readonly pattern: string;
    readonly excludeGlobs: readonly string[];
    readonly maxResults: number;
    readonly maxEntries: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceGlobOutcome> {
    if (
      !Number.isSafeInteger(input.maxResults)
      || !Number.isSafeInteger(input.maxEntries)
      || input.maxResults < 1
      || input.maxResults > 2_000
      || input.maxEntries < input.maxResults
      || input.maxEntries > 20_000
    ) throw new LocalWorkspaceSearchError('workspace_search_input_invalid');
    const pattern = compileGlob(input.pattern);
    const excludes = input.excludeGlobs.map(compileGlob);
    const entries = await traverseWorkspace({
      workspaceRoot: input.workspaceRoot,
      absoluteDirectory: input.absoluteDirectory,
      exclude: excludes,
      maxEntries: input.maxEntries,
      signal: input.signal
    });
    const matches: WorkspaceGlobMatch[] = [];
    for (const entry of entries.items) {
      if (!pattern.test(entry.relativePath)) continue;
      matches.push({ path: entry.relativePath, kind: entry.kind });
      if (matches.length >= input.maxResults) {
        return {
          matches,
          scannedEntries: entries.items.length,
          truncated: true
        };
      }
    }
    return {
      matches,
      scannedEntries: entries.items.length,
      truncated: entries.truncated
    };
  }
}

async function traverseWorkspace(input: {
  readonly workspaceRoot: string;
  readonly absoluteDirectory: string;
  readonly exclude: readonly RegExp[];
  readonly maxEntries: number;
  readonly signal: AbortSignal;
}): Promise<{ readonly items: readonly TraversedEntry[]; readonly truncated: boolean }> {
  assertNotAborted(input.signal);
  const root = await realpath(input.workspaceRoot);
  const start = await realpath(input.absoluteDirectory);
  assertContained(root, start);
  const queue = [start];
  const items: TraversedEntry[] = [];
  while (queue.length > 0) {
    assertNotAborted(input.signal);
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new LocalWorkspaceSearchError('workspace_search_io_error');
    }
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      assertNotAborted(input.signal);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) continue;
      const absolutePath = path.join(directory, entry.name);
      const canonical = await realpath(absolutePath).catch(() => null);
      if (canonical === null) continue;
      assertContained(root, canonical);
      const relativePath = normalizeRelativePath(path.relative(root, canonical));
      const kind = entry.isDirectory() ? 'directory' as const : 'file' as const;
      if (input.exclude.some((pattern) => (
        pattern.test(relativePath)
        || (kind === 'directory' && pattern.test(`${relativePath}/`))
      ))) continue;
      items.push({ absolutePath: canonical, relativePath, kind });
      if (items.length >= input.maxEntries) return { items, truncated: true };
      if (kind === 'directory') queue.push(canonical);
    }
  }
  return { items, truncated: false };
}

function compileGlob(input: string): RegExp {
  if (
    typeof input !== 'string'
    || input.length === 0
    || input.length > 256
    || input.includes('\0')
    || input.includes('\\')
    || input.startsWith('/')
    || input.split('/').includes('..')
  ) throw new LocalWorkspaceSearchError('workspace_search_glob_invalid');
  let expression = '^';
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character === '*' && input[index + 1] === '*') {
      if (input[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`${expression}$`, 'u');
}

function assertSearchInput(query: string, bounds: WorkspaceSearchBounds): void {
  if (
    typeof query !== 'string'
    || query.length === 0
    || query.length > 1_024
    || !Number.isSafeInteger(bounds.maxResults)
    || bounds.maxResults < 1
    || bounds.maxResults > 1_000
    || !Number.isSafeInteger(bounds.maxFiles)
    || bounds.maxFiles < 1
    || bounds.maxFiles > 20_000
    || !Number.isSafeInteger(bounds.maxTotalBytes)
    || bounds.maxTotalBytes < 1
    || bounds.maxTotalBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(bounds.maxFileBytes)
    || bounds.maxFileBytes < 1
    || bounds.maxFileBytes > bounds.maxTotalBytes
  ) throw new LocalWorkspaceSearchError('workspace_search_input_invalid');
}

function textLines(content: string): readonly { readonly number: number; readonly text: string }[] {
  return content.split(/\r\n|\n|\r/u).map((text, index) => ({ number: index + 1, text }));
}

function boundedPreview(input: string, maximumCharacters: number): string {
  const points = Array.from(input);
  if (points.length <= maximumCharacters) return input;
  const left = Math.ceil((maximumCharacters - 1) / 2);
  const right = Math.floor((maximumCharacters - 1) / 2);
  return `${points.slice(0, left).join('')}…${points.slice(points.length - right).join('')}`;
}

function isSkippableFileError(error: unknown): boolean {
  return error instanceof LocalWorkspaceFileError && [
    'workspace_file_changed_during_read',
    'workspace_file_not_found',
    'workspace_file_not_regular',
    'workspace_file_not_text',
    'workspace_file_too_large'
  ].includes(error.code);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new LocalWorkspaceSearchError('workspace_search_aborted');
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) throw new LocalWorkspaceSearchError('workspace_search_boundary_invalid');
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
