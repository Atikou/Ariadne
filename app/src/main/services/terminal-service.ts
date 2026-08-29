import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import {
  LocalLiveWorkRegistry,
  type LiveWorkOutcome,
  type LiveWorkOwner,
  type LiveWorkSnapshot
} from '@ariadne/live-work';
import { spawn } from 'node-pty';
import type {
  CreateTerminalSessionRequest,
  ResizeTerminalRequest,
  SignalTerminalRequest,
  TerminalRecoveryRecord,
  TerminalSession,
  WriteTerminalRequest
} from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';
import type { TerminalSessionJournal } from '../persistence/terminal-session-journal';

const MAX_SESSIONS_PER_RENDERER = 8;

/**
 * Electron PTY producer backed by the same live-work registry as Runtime
 * processes. Main owns the PTY; the registry owns lifecycle, owner fencing,
 * output cursors, retention, cancellation, and completion ordering.
 */
export class TerminalSessionService {
  private readonly registry = new LocalLiveWorkRegistry({
    createId: randomUUID,
    maxConcurrentPerOwner: MAX_SESSIONS_PER_RENDERER
  });
  private readonly owners = new Map<number, WebContents>();
  private readonly sessionOwners = new Map<string, LiveWorkOwner>();
  private readonly ownerDestroyedListeners = new Map<number, { owner: WebContents; listener: () => void }>();
  private readonly removeOutputListener: () => void;
  private readonly removeDoneListener: () => void;

  public constructor(
    private readonly resolveWorkingDirectory: (workspaceId: string) => string,
    private readonly journal: TerminalSessionJournal
  ) {
    this.removeOutputListener = this.registry.onOutput(({ snapshot, chunk }) => {
      const owner = this.ownerFor(snapshot);
      if (!owner || owner.isDestroyed()) return;
      owner.send(IPC_CHANNELS.terminalOutput, {
        sessionId: snapshot.id,
        work: snapshot,
        chunk
      });
    });
    this.removeDoneListener = this.registry.onDone(({ snapshot }) => {
      const owner = this.ownerFor(snapshot);
      if (owner && !owner.isDestroyed()) {
        owner.send(IPC_CHANNELS.terminalExit, { sessionId: snapshot.id, work: snapshot });
      }
      void this.journal.finish(snapshot.id, {
        status: requireTerminalStatus(snapshot.status),
        ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
        ...(snapshot.detail === undefined ? {} : { detail: snapshot.detail })
      }).catch((error: unknown) => {
        console.error('Unable to persist terminal completion.', error);
      });
      this.sessionOwners.delete(snapshot.id);
      this.releaseOwnerIfIdle(Number(snapshot.owner.ownerId));
    });
  }

  public async initialize(): Promise<void> {
    await this.journal.initialize();
  }

  public listRecoveryRecords(): TerminalRecoveryRecord[] {
    return this.journal.list();
  }

  public async create(owner: WebContents, request: CreateTerminalSessionRequest): Promise<TerminalSession> {
    if (process.platform !== 'win32') throw new Error('PowerShell and CMD terminals require Windows.');
    const cwd = this.resolveWorkingDirectory(request.workspaceId);
    const shell = resolveShell(request.shell);
    this.owners.set(owner.id, owner);
    this.watchOwner(owner);
    await this.journal.start({
      sessionId: request.sessionId,
      workspaceId: request.workspaceId,
      shell: request.shell,
      ...(request.restartOf === undefined ? {} : { restartOf: request.restartOf })
    });

    let cancelled = false;
    let work: LiveWorkSnapshot;
    try {
      work = this.registry.start({
      kind: 'terminal',
      label: `${request.shell}:${cwd}`.slice(0, 1_024),
      owner: terminalOwner(owner.id, request.workspaceId),
      preferredId: request.sessionId,
      metadata: { shell: request.shell, cwd },
      start: (context) => {
        const terminal = spawn(shell.executable, shell.args, {
          name: 'xterm-256color',
          cols: request.columns,
          rows: request.rows,
          cwd,
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor'
          },
          useConpty: true,
          useConptyDll: true
        });
        context.patchMetadata({ processId: terminal.pid });
        let resolveDone!: (outcome: LiveWorkOutcome) => void;
        const done = new Promise<LiveWorkOutcome>((resolve) => { resolveDone = resolve; });
        terminal.onData((data) => context.appendOutput('terminal', data));
        terminal.onExit(({ exitCode, signal }) => {
          if (typeof signal === 'number') context.patchMetadata({ signal });
          resolveDone(cancelled
            ? { status: 'killed', exitCode }
            : exitCode === 0
              ? { status: 'completed', exitCode }
              : { status: 'failed', exitCode, detail: `terminal_exit_${exitCode}` });
        });
        return {
          done,
          cancel: () => {
            cancelled = true;
            safelyKill(terminal);
          },
          write: (text) => terminal.write(text),
          resize: ({ columns, rows }) => terminal.resize(columns, rows),
          signal: (signal) => {
            if (signal === 'interrupt') terminal.write('\x03');
            else {
              cancelled = true;
              safelyKill(terminal);
            }
          }
        };
      }
      });
    } catch (error) {
      await this.journal.finish(request.sessionId, {
        status: 'failed',
        detail: error instanceof Error ? error.message.slice(0, 4_096) : String(error).slice(0, 4_096)
      });
      this.releaseOwnerIfIdle(owner.id);
      throw error;
    }
    this.sessionOwners.set(work.id, work.owner);

    return { id: work.id, workspaceId: request.workspaceId, shell: request.shell, cwd, work };
  }

  public async write(ownerId: number, request: WriteTerminalRequest): Promise<void> {
    const owner = this.ownerForId(ownerId, request.sessionId);
    await this.registry.write(owner, request.sessionId, request.data);
  }

  public async resize(ownerId: number, request: ResizeTerminalRequest): Promise<void> {
    const owner = this.ownerForId(ownerId, request.sessionId);
    await this.registry.resize(owner, request.sessionId, {
      columns: request.columns,
      rows: request.rows
    });
  }

  public async signal(ownerId: number, request: SignalTerminalRequest): Promise<void> {
    const owner = this.ownerForId(ownerId, request.sessionId);
    await this.registry.signal(owner, request.sessionId, request.signal);
  }

  public async close(ownerId: number, sessionId: string): Promise<void> {
    const snapshot = this.findOwned(ownerId, sessionId);
    if (snapshot === undefined) return;
    await this.registry.kill(snapshot.owner, sessionId, 'renderer_requested');
  }

  public async closeOwnedBy(ownerId: number): Promise<void> {
    await this.registry.closeAuthorityOwner('renderer', String(ownerId));
  }

  public async dispose(): Promise<void> {
    this.removeOutputListener();
    this.removeDoneListener();
    await this.registry.close();
    for (const { owner, listener } of this.ownerDestroyedListeners.values()) {
      owner.removeListener('destroyed', listener);
    }
    this.ownerDestroyedListeners.clear();
    this.owners.clear();
    this.sessionOwners.clear();
    await this.journal.flush();
  }

  private ownerFor(snapshot: LiveWorkSnapshot): WebContents | undefined {
    return this.owners.get(Number(snapshot.owner.ownerId));
  }

  private ownerForId(ownerId: number, sessionId: string): LiveWorkOwner {
    const snapshot = this.findOwned(ownerId, sessionId);
    if (snapshot === undefined) throw new Error('Terminal session was not found.');
    return snapshot.owner;
  }

  private findOwned(ownerId: number, sessionId: string): LiveWorkSnapshot | undefined {
    const owner = this.sessionOwners.get(sessionId);
    if (owner === undefined || owner.ownerId !== String(ownerId)) return undefined;
    try {
      return this.registry.get(owner, sessionId);
    } catch (error) {
      if (error instanceof Error && error.message === 'live_work_not_found') return undefined;
      throw error;
    }
  }

  private watchOwner(owner: WebContents): void {
    if (this.ownerDestroyedListeners.has(owner.id)) return;
    const listener = (): void => { void this.closeOwnedBy(owner.id); };
    this.ownerDestroyedListeners.set(owner.id, { owner, listener });
    owner.once('destroyed', listener);
  }

  private releaseOwnerIfIdle(ownerId: number): void {
    const hasLive = [...this.sessionOwners.values()].some((owner) => owner.ownerId === String(ownerId));
    if (hasLive) return;
    const watched = this.ownerDestroyedListeners.get(ownerId);
    if (watched) {
      watched.owner.removeListener('destroyed', watched.listener);
      this.ownerDestroyedListeners.delete(ownerId);
    }
    this.owners.delete(ownerId);
  }
}

function requireTerminalStatus(status: LiveWorkSnapshot['status']): TerminalRecoveryRecord['status'] {
  if (status === 'running' || status === 'stopping') {
    throw new Error('terminal_completion_status_invalid');
  }
  return status;
}

function terminalOwner(ownerId: number, workspaceId: string): LiveWorkOwner {
  return { authority: 'renderer', ownerId: String(ownerId), workspaceId };
}

function resolveShell(shell: CreateTerminalSessionRequest['shell']): { executable: string; args: string[] } {
  switch (shell) {
    case 'powershell': return { executable: 'powershell.exe', args: ['-NoLogo'] };
    case 'cmd': return { executable: 'cmd.exe', args: [] };
  }
}

function safelyKill(terminal: { kill(): void }): void {
  try {
    terminal.kill();
  } catch {
    // The child may have exited between the lookup and the kill request.
  }
}
