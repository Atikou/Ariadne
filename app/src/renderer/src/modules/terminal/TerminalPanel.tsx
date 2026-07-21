import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, SquareTerminal } from 'lucide-react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XtermTerminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalShell } from '@shared/contract';
import type { FeaturePanelProps, ModuleServices } from '@renderer/core/modules/module-contract';

type TerminalStatus = 'starting' | 'running' | 'exited' | 'error';

interface SessionMetadata {
  status: TerminalStatus;
  cwd: string;
}

interface TerminalSessionViewProps {
  shell: TerminalShell;
  active: boolean;
  services: ModuleServices;
  onMetadata(shell: TerminalShell, metadata: SessionMetadata): void;
}

const SHELLS: ReadonlyArray<{ value: TerminalShell; label: string }> = [
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd', label: 'CMD' }
];

const STATUS_LABELS: Record<TerminalStatus, string> = {
  starting: '正在启动',
  running: '运行中',
  exited: '已退出',
  error: '启动失败'
};

const INITIAL_METADATA: Record<TerminalShell, SessionMetadata> = {
  powershell: { status: 'starting', cwd: '' },
  cmd: { status: 'starting', cwd: '' }
};

export function TerminalPanel({ services }: FeaturePanelProps): React.JSX.Element {
  const [activeShell, setActiveShell] = useState<TerminalShell>('powershell');
  const [startedShells, setStartedShells] = useState<ReadonlySet<TerminalShell>>(() => new Set(['powershell']));
  const [restartKeys, setRestartKeys] = useState<Record<TerminalShell, number>>({ powershell: 0, cmd: 0 });
  const [metadata, setMetadata] = useState<Record<TerminalShell, SessionMetadata>>(INITIAL_METADATA);
  const activeMetadata = metadata[activeShell];

  const updateMetadata = useCallback((shell: TerminalShell, next: SessionMetadata): void => {
    setMetadata((current) => {
      const previous = current[shell];
      if (previous.status === next.status && previous.cwd === next.cwd) return current;
      return { ...current, [shell]: next };
    });
  }, []);

  const selectShell = (shell: TerminalShell): void => {
    setStartedShells((current) => {
      if (current.has(shell)) return current;
      return new Set([...current, shell]);
    });
    setActiveShell(shell);
  };

  const restartActiveShell = (): void => {
    setMetadata((current) => ({ ...current, [activeShell]: INITIAL_METADATA[activeShell] }));
    setRestartKeys((current) => ({ ...current, [activeShell]: current[activeShell] + 1 }));
  };

  return (
    <section className="terminal-panel" aria-label="集成终端">
      <header className="terminal-toolbar">
        <div className="terminal-shell-switcher" role="group" aria-label="选择命令行">
          {SHELLS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={activeShell === option.value ? 'is-active' : ''}
              aria-pressed={activeShell === option.value}
              onClick={() => selectShell(option.value)}
            >
              <SquareTerminal size={12} />
              {option.label}
            </button>
          ))}
        </div>
        <div className="terminal-session-meta">
          <span className={`terminal-status terminal-status--${activeMetadata.status}`}>{STATUS_LABELS[activeMetadata.status]}</span>
          {activeMetadata.cwd && <span className="terminal-cwd" title={activeMetadata.cwd}>{activeMetadata.cwd}</span>}
          <button type="button" className="terminal-restart" title="重新启动当前终端" aria-label="重新启动当前终端" onClick={restartActiveShell}>
            <RotateCw size={13} />
          </button>
        </div>
      </header>
      <div className="terminal-session-stack">
        {SHELLS.filter(({ value }) => startedShells.has(value)).map(({ value }) => (
          <TerminalSessionView
            key={`${value}-${restartKeys[value]}`}
            shell={value}
            active={activeShell === value}
            services={services}
            onMetadata={updateMetadata}
          />
        ))}
      </div>
    </section>
  );
}

function TerminalSessionView({ shell, active, services, onMetadata }: TerminalSessionViewProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionReadyRef = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let disposed = false;
    const sessionId = window.crypto.randomUUID();
    const terminal = new XtermTerminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.3,
      scrollback: 5000,
      theme: readTerminalTheme(),
      allowTransparency: true
    });
    const fitAddon = new FitAddon();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    sessionIdRef.current = sessionId;
    terminal.loadAddon(fitAddon);
    terminal.open(viewport);
    fitSafely(fitAddon);
    onMetadata(shell, INITIAL_METADATA[shell]);

    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = readTerminalTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    const inputSubscription = terminal.onData((data) => {
      services.terminal.write({ sessionId, data });
    });
    const removeDataListener = services.terminal.onData((event) => {
      if (event.sessionId === sessionId) terminal.write(event.data);
    });
    const removeExitListener = services.terminal.onExit((event) => {
      if (event.sessionId !== sessionId || disposed) return;
      sessionReadyRef.current = false;
      terminal.options.disableStdin = true;
      terminal.writeln(`\r\n\x1b[90m[进程已退出，代码 ${event.exitCode}]\x1b[0m`);
      onMetadata(shell, { status: 'exited', cwd: '' });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (!activeRef.current || !sessionReadyRef.current || !fitSafely(fitAddon)) return;
      services.terminal.resize({
        sessionId,
        columns: Math.max(2, terminal.cols),
        rows: Math.max(1, terminal.rows)
      });
    });
    resizeObserver.observe(viewport);

    void services.terminal.create({
      sessionId,
      shell,
      columns: Math.max(2, terminal.cols),
      rows: Math.max(1, terminal.rows)
    }).then((session) => {
      if (disposed) {
        services.terminal.close({ sessionId });
        return;
      }
      sessionReadyRef.current = true;
      onMetadata(shell, { status: 'running', cwd: session.cwd });
      if (activeRef.current) {
        fitAndResize(terminal, fitAddon, services, sessionId);
        terminal.focus();
      }
    }).catch((error: unknown) => {
      if (disposed) return;
      terminal.options.disableStdin = true;
      terminal.writeln(`\r\n\x1b[31m无法启动终端：${getErrorMessage(error)}\x1b[0m`);
      onMetadata(shell, { status: 'error', cwd: '' });
    });

    return () => {
      disposed = true;
      sessionReadyRef.current = false;
      themeObserver.disconnect();
      resizeObserver.disconnect();
      removeDataListener();
      removeExitListener();
      inputSubscription.dispose();
      services.terminal.close({ sessionId });
      terminal.dispose();
      if (sessionIdRef.current === sessionId) sessionIdRef.current = null;
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitAddonRef.current === fitAddon) fitAddonRef.current = null;
    };
  }, [onMetadata, services, shell]);

  useEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      const terminal = terminalRef.current;
      const fitAddon = fitAddonRef.current;
      const sessionId = sessionIdRef.current;
      if (!terminal || !fitAddon || !sessionId) return;
      if (sessionReadyRef.current) fitAndResize(terminal, fitAddon, services, sessionId);
      else fitSafely(fitAddon);
      terminal.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active, services]);

  return (
    <div
      ref={viewportRef}
      className={`terminal-viewport terminal-session${active ? ' is-active' : ''}`}
      aria-label={`${shell === 'powershell' ? 'PowerShell' : 'CMD'} 终端`}
      aria-hidden={!active}
    />
  );
}

function fitAndResize(
  terminal: XtermTerminal,
  fitAddon: FitAddon,
  services: ModuleServices,
  sessionId: string
): void {
  if (!fitSafely(fitAddon)) return;
  services.terminal.resize({
    sessionId,
    columns: Math.max(2, terminal.cols),
    rows: Math.max(1, terminal.rows)
  });
}

function fitSafely(fitAddon: FitAddon): boolean {
  try {
    fitAddon.fit();
    return true;
  } catch {
    return false;
  }
}

function readTerminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: color('--bg-1', '#111318'),
    foreground: color('--text-2', '#a9b0bd'),
    cursor: color('--text-1', '#eceef2'),
    cursorAccent: color('--bg-1', '#111318'),
    selectionBackground: color('--accent-soft', 'rgba(140, 166, 255, 0.24)'),
    black: '#15171c',
    red: color('--danger', '#d97783'),
    green: color('--success', '#61c79b'),
    yellow: color('--warning', '#d5a85d'),
    blue: color('--accent', '#8ca6ff'),
    magenta: '#c594dd',
    cyan: '#67c7d4',
    white: color('--text-1', '#eceef2'),
    brightBlack: color('--text-3', '#707988'),
    brightRed: '#ef8c98',
    brightGreen: '#7bdcb1',
    brightYellow: '#e7bd76',
    brightBlue: '#a6b9ff',
    brightMagenta: '#daa9ee',
    brightCyan: '#82d9e3',
    brightWhite: '#ffffff'
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
