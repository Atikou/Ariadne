import { randomUUID } from 'node:crypto';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { RuntimeCommand, RuntimeResult } from '@ariadne/protocol/public';
import type { SessionTextExportRequest, SessionTextExportResult } from '@shared/data-management';
import { writeSessionTextExport } from './session-text-export';

/** Main selects a new target. Publish a fully flushed private sibling with an
 * exclusive hard link, so an existing or concurrently created file is never
 * overwritten. Filesystems without this primitive fail without a partial export. */
export class SessionExportService {
  private active = false;
  private idle: Promise<void> = Promise.resolve();
  get busy(): boolean { return this.active; }
  waitForIdle(): Promise<void> { return this.idle; }
  constructor(private readonly request: (command: RuntimeCommand) => Promise<RuntimeResult>, private readonly forbiddenRoots: readonly string[]) {}
  async create(input: SessionTextExportRequest, destination: string): Promise<SessionTextExportResult> {
    if (this.active) throw new Error('session_export_busy');
    this.active = true; let done!: () => void; this.idle = new Promise(resolve => { done = resolve; });
    let file: Awaited<ReturnType<typeof open>> | undefined, stage: string | undefined;
    let identity: { dev: number; ino: number } | undefined;
    try {
      if (!isAbsolute(destination)) throw new Error('session_export_destination_invalid');
      const parent = await realpath(dirname(destination));
      if (parent !== dirname(destination) || (await lstat(parent)).isSymbolicLink()) throw new Error('session_export_destination_alias');
      for (const source of this.forbiddenRoots) {
        const distance = relative(await realpath(source), parent);
        if (!distance || (!isAbsolute(distance) && distance !== '..' && !distance.startsWith('..' + sep))) throw new Error('session_export_destination_inside_source');
      }
      stage = join(parent, '.ariadne-session-export-' + randomUUID() + '.tmp');
      file = await open(stage, 'wx', 0o600); const opened = await file.stat(); identity = { dev: opened.dev, ino: opened.ino };
      const result = await writeSessionTextExport(input, this.request, async line => { await file!.writeFile(line); });
      await file.sync(); await file.close(); file = undefined;
      const named = await lstat(stage);
      if (!named.isFile() || named.isSymbolicLink() || named.dev !== identity.dev || named.ino !== identity.ino || named.size !== result.bytes)
        throw new Error('session_export_stage_changed');
      await link(stage, destination); return result;
    } finally {
      try {
        await file?.close();
        if (stage && identity) {
          const named = await lstat(stage);
          if (named.isSymbolicLink() || named.dev !== identity.dev || named.ino !== identity.ino) throw new Error('session_export_cleanup_identity_changed');
          await unlink(stage);
        }
      } finally { this.active = false; done(); }
    }
  }
}
