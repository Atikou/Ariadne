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

  create(owner: WebContents, request: CreateTerminalSessionRequest): TerminalSession {
    if (process.platform !== 'win32') throw new Error('PowerShell and CMD terminals require Windows.');
    if (this.sessions.has(request.sessionId)) throw new Error('Terminal session already exists.');

    const activeSessionCount = [...this.sessions.values()].filter((session) => session.ownerId === owner.id).length;
    if (activeSessionCount >= MAX_SESSIONS_PER_RENDERER) throw new Error('Too many terminal sessions are open.');

    const cwd = process.cwd();
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
      useConpty: true
    });

    const session: ManagedTerminalSession = {
      id: request.sessionId,
      shell: request.shell,
      cwd,
      ownerId: owner.id,
      pty: terminal
    };
    this.sessions.set(session.id, session);

    terminal.onData((data) => {
      if (!owner.isDestroyed()) owner.send(IPC_CHANNELS.terminalData, { sessionId: session.id, data });
    });
    terminal.onExit(({ exitCode, signal }) => {
      this.sessions.delete(session.id);
      if (!owner.isDestroyed()) {
        owner.send(IPC_CHANNELS.terminalExit, {
          sessionId: session.id,
          exitCode,
          ...(typeof signal === 'number' ? { signal } : {})
        });
      }
    });

    return { id: session.id, shell: session.shell, cwd: session.cwd };
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
  }

  closeOwnedBy(ownerId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === ownerId) this.close(ownerId, session.id);
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) safelyKill(session.pty);
    this.sessions.clear();
  }

  private getOwnedSession(ownerId: number, sessionId: string): ManagedTerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.ownerId !== ownerId) throw new Error('Terminal session was not found.');
    return session;
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
