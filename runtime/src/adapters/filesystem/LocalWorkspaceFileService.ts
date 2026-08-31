import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  link,
  mkdir,
  open,
  rename,
  rm,
  unlink,
  type FileHandle
} from 'node:fs/promises';
import path from 'node:path';

import type {
  WorkspaceFileService,
  WorkspaceFileVersion,
  WorkspaceTextEdit,
  WorkspaceTextFileEditOutcome,
  WorkspaceTextFileDeleteOutcome,
  WorkspaceTextFileMoveOutcome,
  WorkspaceTextFileReadOutcome,
  WorkspaceTextFileWriteIntent,
  WorkspaceTextFileWriteOutcome
} from '../../control/ports/WorkspaceFileService.js';

export type LocalWorkspaceFileErrorCode =
  | 'workspace_file_aborted'
  | 'workspace_file_already_exists'
  | 'workspace_file_changed_during_read'
  | 'workspace_file_io_error'
  | 'workspace_file_not_found'
  | 'workspace_file_not_regular'
  | 'workspace_file_not_text'
  | 'workspace_file_edit_invalid'
  | 'workspace_file_edit_overlap'
  | 'workspace_file_permission_denied'
  | 'workspace_file_stale_version'
  | 'workspace_file_too_large';

export class LocalWorkspaceFileError extends Error {
  constructor(readonly code: LocalWorkspaceFileErrorCode) {
    super(code);
    this.name = 'LocalWorkspaceFileError';
  }
}

interface StableFileObservation extends WorkspaceTextFileReadOutcome {
  readonly mode: number;
  readonly device: bigint;
  readonly inode: bigint;
}

/**
 * Local implementation of the v3 workspace-file boundary.
 *
 * Service-owned writes to one target are serialized. Replacement is
 * revalidated immediately before a same-directory atomic rename; creation is
 * published through a no-replace hard link, never an in-place partial write.
 */
export class LocalWorkspaceFileService implements WorkspaceFileService {
  private readonly targetLocks = new Map<string, Promise<void>>();

  async readText(input: {
    readonly absolutePath: string;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileReadOutcome> {
    try {
      return await observeStableTextFile(
        input.absolutePath,
        input.maxBytes,
        input.signal
      );
    } catch (error) {
      throw normalizeReadError(error);
    }
  }

  async writeText(input: {
    readonly absolutePath: string;
    readonly content: string;
    readonly expected: WorkspaceTextFileWriteIntent;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileWriteOutcome> {
    const bytes = Buffer.from(input.content, 'utf8');
    if (bytes.byteLength > input.maxBytes) {
      throw new LocalWorkspaceFileError('workspace_file_too_large');
    }
    assertNotAborted(input.signal);
    try {
      await mkdir(path.dirname(input.absolutePath), { recursive: true });
    } catch (error) {
      throw normalizeWriteError(error, input.expected);
    }

    return this.withTargetLock(input.absolutePath, async () => {
      try {
        return await this.writeInsideLock({ ...input, bytes });
      } catch (error) {
        throw normalizeWriteError(error, input.expected);
      }
    });
  }

  async editText(input: {
    readonly absolutePath: string;
    readonly edits: readonly WorkspaceTextEdit[];
    readonly expectedVersion: WorkspaceFileVersion;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileEditOutcome> {
    if (input.edits.length === 0 || input.edits.length > 128) {
      throw new LocalWorkspaceFileError('workspace_file_edit_invalid');
    }
    assertNotAborted(input.signal);
    const expected: WorkspaceTextFileWriteIntent = {
      kind: 'replace_if_version',
      version: input.expectedVersion
    };
    return this.withTargetLock(input.absolutePath, async () => {
      try {
        const observed = await observeStableTextFile(
          input.absolutePath,
          input.maxBytes,
          input.signal
        );
        if (observed.version !== input.expectedVersion) {
          throw new LocalWorkspaceFileError('workspace_file_stale_version');
        }
        const content = applyTextEdits(observed.content, input.edits);
        const bytes = Buffer.from(content, 'utf8');
        if (bytes.byteLength > input.maxBytes) {
          throw new LocalWorkspaceFileError('workspace_file_too_large');
        }
        const written = await this.writeInsideLock({
          absolutePath: input.absolutePath,
          bytes,
          expected,
          maxBytes: input.maxBytes,
          signal: input.signal
        });
        return {
          operation: 'edited',
          byteLength: written.byteLength,
          version: written.version,
          appliedEdits: input.edits.length,
          previousContent: observed.content,
          content
        };
      } catch (error) {
        throw normalizeWriteError(error, expected);
      }
    });
  }

  async moveText(input: {
    readonly sourceAbsolutePath: string;
    readonly destinationAbsolutePath: string;
    readonly expectedVersion: WorkspaceFileVersion;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileMoveOutcome> {
    if (input.sourceAbsolutePath === input.destinationAbsolutePath) {
      throw new LocalWorkspaceFileError('workspace_file_edit_invalid');
    }
    return this.withTargetLocks([
      input.sourceAbsolutePath,
      input.destinationAbsolutePath
    ], async () => {
      const observed = await observeStableTextFile(
        input.sourceAbsolutePath,
        input.maxBytes,
        input.signal
      );
      if (observed.version !== input.expectedVersion) {
        throw new LocalWorkspaceFileError('workspace_file_stale_version');
      }
      await mkdir(path.dirname(input.destinationAbsolutePath), { recursive: true });
      let linked = false;
      try {
        await link(input.sourceAbsolutePath, input.destinationAbsolutePath);
        linked = true;
        const destination = await observeStableTextFile(
          input.destinationAbsolutePath,
          input.maxBytes,
          input.signal
        );
        if (
          destination.device !== observed.device
          || destination.inode !== observed.inode
          || destination.content !== observed.content
        ) {
          throw new LocalWorkspaceFileError('workspace_file_stale_version');
        }
        await unlink(input.sourceAbsolutePath);
        linked = false;
        const published = await observeStableTextFile(
          input.destinationAbsolutePath,
          input.maxBytes,
          input.signal
        );
        return {
          operation: 'moved',
          byteLength: published.byteLength,
          version: published.version
        };
      } catch (error) {
        if (linked) await rm(input.destinationAbsolutePath, { force: true }).catch(() => undefined);
        throw normalizeMoveDeleteError(error);
      }
    });
  }

  async deleteText(input: {
    readonly absolutePath: string;
    readonly expectedVersion: WorkspaceFileVersion;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileDeleteOutcome> {
    return this.withTargetLock(input.absolutePath, async () => {
      const observed = await observeStableTextFile(
        input.absolutePath,
        input.maxBytes,
        input.signal
      );
      if (observed.version !== input.expectedVersion) {
        throw new LocalWorkspaceFileError('workspace_file_stale_version');
      }
      const quarantine = path.join(
        path.dirname(input.absolutePath),
        `.${path.basename(input.absolutePath)}.ariadne-delete-${randomUUID()}.tmp`
      );
      let moved = false;
      try {
        await rename(input.absolutePath, quarantine);
        moved = true;
        const quarantined = await observeStableTextFile(
          quarantine,
          input.maxBytes,
          input.signal
        );
        if (
          quarantined.device !== observed.device
          || quarantined.inode !== observed.inode
          || quarantined.content !== observed.content
        ) {
          throw new LocalWorkspaceFileError('workspace_file_stale_version');
        }
        await unlink(quarantine);
        moved = false;
        return { operation: 'deleted', byteLength: observed.byteLength };
      } catch (error) {
        if (moved) {
          await rename(quarantine, input.absolutePath).catch(() => undefined);
        }
        throw normalizeMoveDeleteError(error);
      }
    });
  }

  private async writeInsideLock(input: {
    readonly absolutePath: string;
    readonly bytes: Buffer;
    readonly expected: WorkspaceTextFileWriteIntent;
    readonly maxBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WorkspaceTextFileWriteOutcome> {
    assertNotAborted(input.signal);
    let initial: StableFileObservation | undefined;
    if (input.expected.kind === 'replace_if_version') {
      initial = await observeStableTextFile(
        input.absolutePath,
        input.maxBytes,
        input.signal
      );
      if (initial.version !== input.expected.version) {
        throw new LocalWorkspaceFileError('workspace_file_stale_version');
      }
    }

    const temporaryPath = path.join(
      path.dirname(input.absolutePath),
      `.${path.basename(input.absolutePath)}.ariadne-${randomUUID()}.tmp`
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, 'wx', initial?.mode ?? 0o666);
      await handle.writeFile(input.bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      assertNotAborted(input.signal);

      if (input.expected.kind === 'create_if_absent') {
        await link(temporaryPath, input.absolutePath);
        await rm(temporaryPath, { force: true });
      } else {
        const current = await observeStableTextFile(
          input.absolutePath,
          input.maxBytes,
          input.signal
        );
        if (current.version !== input.expected.version) {
          throw new LocalWorkspaceFileError('workspace_file_stale_version');
        }
        await rename(temporaryPath, input.absolutePath);
      }

      const published = await observeStableTextFile(
        input.absolutePath,
        input.maxBytes,
        new AbortController().signal
      );
      return {
        operation: input.expected.kind === 'create_if_absent' ? 'created' : 'replaced',
        byteLength: input.bytes.byteLength,
        version: published.version,
        previousContent: initial?.content ?? null,
        content: input.bytes.toString('utf8')
      };
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async withTargetLock<T>(
    targetPath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
    const previous = this.targetLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.targetLocks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.targetLocks.get(key) === tail) this.targetLocks.delete(key);
    }
  }

  private async withTargetLocks<T>(
    targetPaths: readonly string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const paths = [...new Set(targetPaths)].sort();
    const acquire = (index: number): Promise<T> => index >= paths.length
      ? operation()
      : this.withTargetLock(paths[index]!, () => acquire(index + 1));
    return acquire(0);
  }
}

interface ResolvedTextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface TextLineRange {
  readonly start: number;
  readonly end: number;
}

function applyTextEdits(
  content: string,
  edits: readonly WorkspaceTextEdit[]
): string {
  const lines = textLineRanges(content);
  const resolved = edits.map((edit) => ({
    start: resolveTextPosition(content, lines, edit.start.line, edit.start.column),
    end: resolveTextPosition(content, lines, edit.end.line, edit.end.column),
    text: edit.text
  })).sort((left, right) => left.start - right.start || left.end - right.end);
  for (const edit of resolved) {
    if (edit.start > edit.end) {
      throw new LocalWorkspaceFileError('workspace_file_edit_invalid');
    }
  }
  for (let index = 1; index < resolved.length; index += 1) {
    const previous = resolved[index - 1]!;
    const current = resolved[index]!;
    if (
      current.start < previous.end
      || (
        current.start === previous.start
        && current.start === current.end
        && previous.start === previous.end
      )
    ) throw new LocalWorkspaceFileError('workspace_file_edit_overlap');
  }
  return [...resolved].reverse().reduce((value, edit) => (
    `${value.slice(0, edit.start)}${edit.text}${value.slice(edit.end)}`
  ), content);
}

function textLineRanges(content: string): readonly TextLineRange[] {
  const lines: TextLineRange[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character !== '\n' && character !== '\r') continue;
    lines.push({ start, end: index });
    if (character === '\r' && content[index + 1] === '\n') index += 1;
    start = index + 1;
  }
  lines.push({ start, end: content.length });
  return lines;
}

function resolveTextPosition(
  content: string,
  lines: readonly TextLineRange[],
  line: number,
  column: number
): number {
  if (
    !Number.isSafeInteger(line)
    || !Number.isSafeInteger(column)
    || line < 1
    || column < 1
    || line > lines.length
  ) throw new LocalWorkspaceFileError('workspace_file_edit_invalid');
  const range = lines[line - 1]!;
  const points = Array.from(content.slice(range.start, range.end));
  if (column > points.length + 1) {
    throw new LocalWorkspaceFileError('workspace_file_edit_invalid');
  }
  return range.start + points.slice(0, column - 1).join('').length;
}

async function observeStableTextFile(
  absolutePath: string,
  maxBytes: number,
  signal: AbortSignal
): Promise<StableFileObservation> {
  assertNotAborted(signal);
  const handle = await open(absolutePath, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      throw new LocalWorkspaceFileError('workspace_file_not_regular');
    }
    if (before.size > BigInt(maxBytes)) {
      throw new LocalWorkspaceFileError('workspace_file_too_large');
    }
    const expectedLength = Number(before.size);
    const bytes = Buffer.alloc(expectedLength);
    let offset = 0;
    while (offset < expectedLength) {
      assertNotAborted(signal);
      const read = await handle.read(bytes, offset, expectedLength - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const overflow = Buffer.alloc(1);
    const overflowRead = await handle.read(overflow, 0, 1, null);
    const after = await handle.stat({ bigint: true });
    if (
      offset !== expectedLength
      || overflowRead.bytesRead !== 0
      || !sameFileStat(before, after)
    ) {
      throw new LocalWorkspaceFileError('workspace_file_changed_during_read');
    }
    assertNotAborted(signal);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new LocalWorkspaceFileError('workspace_file_not_text');
    }
    return {
      content,
      byteLength: bytes.byteLength,
      version: fileVersion(before, bytes),
      mode: Number(before.mode & 0o777n),
      device: before.dev,
      inode: before.ino
    };
  } finally {
    await handle.close();
  }
}

function sameFileStat(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function fileVersion(stat: BigIntStats, bytes: Buffer): WorkspaceFileVersion {
  const contentDigest = createHash('sha256').update(bytes).digest('hex');
  const identity = [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    contentDigest
  ].map(String).join('\0');
  return `workspace-file-v1:${createHash('sha256').update(identity).digest('hex')}` as
    WorkspaceFileVersion;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new LocalWorkspaceFileError('workspace_file_aborted');
  }
}

function normalizeReadError(error: unknown): Error {
  if (error instanceof LocalWorkspaceFileError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new LocalWorkspaceFileError('workspace_file_not_found');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new LocalWorkspaceFileError('workspace_file_permission_denied');
  }
  return new LocalWorkspaceFileError('workspace_file_io_error');
}

function normalizeWriteError(
  error: unknown,
  expected: WorkspaceTextFileWriteIntent
): Error {
  if (error instanceof LocalWorkspaceFileError) {
    if (
      error.code === 'workspace_file_not_found'
      && expected.kind === 'replace_if_version'
    ) return new LocalWorkspaceFileError('workspace_file_stale_version');
    return error;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EEXIST' && expected.kind === 'create_if_absent') {
    return new LocalWorkspaceFileError('workspace_file_already_exists');
  }
  if (code === 'ENOENT' && expected.kind === 'replace_if_version') {
    return new LocalWorkspaceFileError('workspace_file_stale_version');
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new LocalWorkspaceFileError('workspace_file_permission_denied');
  }
  return new LocalWorkspaceFileError('workspace_file_io_error');
}

function normalizeMoveDeleteError(error: unknown): Error {
  if (error instanceof LocalWorkspaceFileError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new LocalWorkspaceFileError('workspace_file_not_found');
  if (code === 'EEXIST') return new LocalWorkspaceFileError('workspace_file_already_exists');
  if (code === 'EACCES' || code === 'EPERM') {
    return new LocalWorkspaceFileError('workspace_file_permission_denied');
  }
  return new LocalWorkspaceFileError('workspace_file_io_error');
}
