import type { WebContents } from 'electron';
import { spawn, type IPty } from 'node-pty';
import type {
  CreateTerminalSessionRequest,
  ResizeTerminalRequest,
  TerminalSession,
  WriteTerminalRequest
} from '@shared/contract';
import { IPC_CHANNELS } from '@shared/ipc';

const MAX_SESSIONS_PER_RENDERER = 8;

interface ManagedTerminalSession extends TerminalSession {
  ownerId: number;
  pty: IPty;
}

export class TerminalSessionService {
  private readonly sessions = new Map<string, ManagedTerminalSession>();
  private readonly ownerDestroyedListeners = new Map<number, { owner: WebContents; listener: () => void }>();

  constructor(private readonly resolveWorkingDirectory: (workspaceId: string) => string) {}

  create(owner: WebContents, request: CreateTerminalSessionRequest): TerminalSession {
    if (process.platform !== 'win32') throw new Error('PowerShell and CMD terminals require Windows.');
    if (this.sessions.has(request.sessionId)) throw new Error('Terminal session already exists.');

    const activeSessionCount = [...this.sessions.values()].filter((session) => session.ownerId === owner.id).length;
    if (activeSessionCount >= MAX_SESSIONS_PER_RENDERER) throw new Error('Too many terminal sessions are open.');

    const cwd = this.resolveWorkingDirectory(request.workspaceId);
    const shell = resolveShell(request.shell);
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

    const session: ManagedTerminalSession = {
      id: request.sessionId,
      workspaceId: request.workspaceId,
      shell: request.shell,
      cwd,
      ownerId: owner.id,
      pty: terminal
    };
    this.sessions.set(session.id, session);
    this.watchOwner(owner);

    terminal.onData((data) => {
      if (!owner.isDestroyed()) owner.send(IPC_CHANNELS.terminalData, { sessionId: session.id, data });
    });
    terminal.onExit(({ exitCode, signal }) => {
      this.sessions.delete(session.id);
      this.releaseOwnerIfIdle(session.ownerId);
      if (!owner.isDestroyed()) {
        owner.send(IPC_CHANNELS.terminalExit, {
          sessionId: session.id,
          exitCode,
          ...(typeof signal === 'number' ? { signal } : {})
        });
      }
    });

    return {
      id: session.id,
      workspaceId: session.workspaceId,
      shell: session.shell,
      cwd: session.cwd
    };
  }

  write(ownerId: number, request: WriteTerminalRequest): void {
    this.getOwnedSession(ownerId, request.sessionId).pty.write(request.data);
  }

  resize(ownerId: number, request: ResizeTerminalRequest): void {
    this.getOwnedSession(ownerId, request.sessionId).pty.resize(request.columns, request.rows);
  }

  close(ownerId: number, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) return;
    this.sessions.delete(sessionId);
    safelyKill(session.pty);
    this.releaseOwnerIfIdle(ownerId);
  }

  closeOwnedBy(ownerId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === ownerId) this.close(ownerId, session.id);
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) safelyKill(session.pty);
    this.sessions.clear();
    for (const { owner, listener } of this.ownerDestroyedListeners.values()) {
      owner.removeListener('destroyed', listener);
    }
    this.ownerDestroyedListeners.clear();
  }

  private getOwnedSession(ownerId: number, sessionId: string): ManagedTerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) throw new Error('Terminal session was not found.');
    return session;
  }

  private watchOwner(owner: WebContents): void {
    if (this.ownerDestroyedListeners.has(owner.id)) return;
    const listener = (): void => this.closeOwnedBy(owner.id);
    this.ownerDestroyedListeners.set(owner.id, { owner, listener });
    owner.once('destroyed', listener);
  }

  private releaseOwnerIfIdle(ownerId: number): void {
    if ([...this.sessions.values()].some((session) => session.ownerId === ownerId)) return;
    const watched = this.ownerDestroyedListeners.get(ownerId);
    if (!watched) return;
    watched.owner.removeListener('destroyed', watched.listener);
    this.ownerDestroyedListeners.delete(ownerId);
  }
}

function resolveShell(shell: CreateTerminalSessionRequest['shell']): { executable: string; args: string[] } {
  switch (shell) {
    case 'powershell':
      return { executable: 'powershell.exe', args: ['-NoLogo'] };
    case 'cmd':
      return { executable: 'cmd.exe', args: [] };
  }
}

function safelyKill(terminal: IPty): void {
  try {
    terminal.kill();
  } catch {
    // The child may have exited between the lookup and the kill request.
  }
}
