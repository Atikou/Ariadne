import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pty = vi.hoisted(() => {
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const terminal = {
    pid: 4242,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((listener: (data: string) => void) => { dataListener = listener; }),
    onExit: vi.fn((listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListener = listener;
    })
  };
  return {
    terminal,
    spawn: vi.fn(() => terminal),
    data: (value: string) => dataListener?.(value),
    exit: (event: { exitCode: number; signal?: number }) => exitListener?.(event),
    reset: () => {
      dataListener = undefined;
      exitListener = undefined;
      Object.values(terminal).forEach((value) => {
        if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
      });
      pty.spawn.mockClear();
    }
  };
});

vi.mock('node-pty', () => ({ spawn: pty.spawn }));

import { IPC_CHANNELS } from '../src/shared/ipc.js';
import { TerminalSessionService } from '../src/main/services/terminal-service.js';

describe('TerminalSessionService live-work boundary', () => {
  beforeEach(() => pty.reset());

  it('publishes PTY output and completion through the shared cursor lifecycle', async () => {
    const sent: { channel: string; payload: unknown }[] = [];
    const owner = rendererOwner(7, sent);
    const service = new TerminalSessionService(() => 'E:\\workspace');
    const session = service.create(owner, {
      sessionId: '8a74a717-d9c7-4a09-a038-83c138362f1e',
      workspaceId: 'workspace-main',
      shell: 'powershell',
      columns: 120,
      rows: 30
    });

    expect(session.work).toMatchObject({
      id: session.id,
      kind: 'terminal',
      status: 'running',
      owner: { authority: 'renderer', ownerId: '7', workspaceId: 'workspace-main' },
      capabilities: { input: true, resize: true, signal: true },
      metadata: { processId: 4242, shell: 'powershell', cwd: 'E:\\workspace' }
    });

    pty.data('你> ');
    expect(sent.at(-1)).toMatchObject({
      channel: IPC_CHANNELS.terminalOutput,
      payload: {
        sessionId: session.id,
        chunk: { cursor: 0, byteLength: 5, channel: 'terminal', text: '你> ' },
        work: { outputCursor: 5 }
      }
    });

    await service.write(owner.id, { sessionId: session.id, data: 'dir\r' });
    await service.resize(owner.id, { sessionId: session.id, columns: 100, rows: 20 });
    expect(pty.terminal.write).toHaveBeenCalledWith('dir\r');
    expect(pty.terminal.resize).toHaveBeenCalledWith(100, 20);

    pty.exit({ exitCode: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.at(-1)).toMatchObject({
      channel: IPC_CHANNELS.terminalExit,
      payload: { sessionId: session.id, work: { status: 'completed', exitCode: 0 } }
    });
    await service.dispose();
  });

  it('kills and joins all PTYs owned by a destroyed renderer', async () => {
    const sent: { channel: string; payload: unknown }[] = [];
    const owner = rendererOwner(8, sent);
    const service = new TerminalSessionService(() => 'E:\\workspace');
    service.create(owner, {
      sessionId: '8a74a717-d9c7-4a09-a038-83c138362f1e',
      workspaceId: 'workspace-main',
      shell: 'cmd',
      columns: 80,
      rows: 24
    });

    const closing = service.closeOwnedBy(owner.id);
    expect(pty.terminal.kill).toHaveBeenCalledTimes(1);
    pty.exit({ exitCode: 1, signal: 9 });
    await closing;
    expect(sent.at(-1)).toMatchObject({
      channel: IPC_CHANNELS.terminalExit,
      payload: { work: { status: 'killed', exitCode: 1, metadata: { signal: 9 } } }
    });
    await service.dispose();
  });
});

function rendererOwner(
  id: number,
  sent: { channel: string; payload: unknown }[]
): WebContents {
  return {
    id,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); },
    once: vi.fn(),
    removeListener: vi.fn()
  } as unknown as WebContents;
}
