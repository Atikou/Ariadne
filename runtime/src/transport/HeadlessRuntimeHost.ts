import {
  parseHeadlessInput,
  parseHeadlessOutput,
  type HeadlessOutput
} from '@ariadne/protocol/headless';
import type { RuntimeBootstrap } from '@ariadne/protocol/host';
import type {
  RuntimeCommand,
  RuntimeEventEnvelope,
  RuntimeResult
} from '@ariadne/protocol/public';

import {
  RuntimeIngressInitializationError,
  type RuntimeIngress
} from '../ingress/RuntimeIngress.js';
import { createShutdownContext } from '../ingress/ShutdownContext.js';

const MAX_NDJSON_LINE_BYTES = 2 * 1024 * 1024;

export interface HeadlessRuntimeHostOptions {
  readonly once?: boolean;
  readonly write?: (line: string) => void;
  readonly log?: (line: string) => void;
}

/** Portless NDJSON adapter over the same RuntimeIngress used by Electron IPC. */
export class HeadlessRuntimeHost {
  private readonly writeLine: (line: string) => void;
  private readonly logLine: (line: string) => void;
  private readonly once: boolean;
  private initialized = false;
  private closing = false;
  private commandCount = 0;
  private runtimeInstanceId?: string;
  private lastCursor = 0;
  private bufferedEvents: RuntimeEventEnvelope[] = [];
  public exitCode = 0;

  public constructor(
    private readonly ingress: RuntimeIngress,
    options: HeadlessRuntimeHostOptions = {}
  ) {
    this.once = options.once ?? false;
    this.writeLine = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.logLine = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  public async handleLine(line: string): Promise<boolean> {
    if (this.closing) return false;
    if (Buffer.byteLength(line, 'utf8') > MAX_NDJSON_LINE_BYTES) {
      return this.fail(
        'ndjson_line_too_large',
        'NDJSON input exceeds the 2 MiB limit.',
        2
      );
    }
    let input;
    try {
      input = parseHeadlessInput(JSON.parse(line));
    } catch {
      return this.fail(
        'ndjson_input_invalid',
        'Invalid Ariadne headless protocol input.',
        2
      );
    }

    if (input.type === 'hello') {
      if (this.initialized) {
        return this.fail(
          'duplicate_hello',
          'Headless Runtime was already initialized.',
          2
        );
      }
      return this.initialize(input.bootstrap, input.resumeCursor);
    }
    if (!this.initialized) {
      return this.fail(
        'hello_required',
        'The first headless message must be hello.',
        2
      );
    }
    if (input.type === 'shutdown') {
      const stopped = await this.shutdown(
        Date.parse(
          input.deadlineAt
          ?? new Date(Date.now() + 10_000).toISOString()
        )
      );
      this.send(stopped ? {
        type: 'response',
        requestId: input.requestId,
        outcome: { ok: true, result: { kind: 'acknowledged' } }
      } : {
        type: 'response',
        requestId: input.requestId,
        outcome: {
          ok: false,
          error: {
            code: 'headless_shutdown_failed',
            message: 'Headless Runtime did not finish shutdown before its deadline.',
            retryable: false,
            correlationId: input.requestId
          }
        }
      });
      return false;
    }

    const completed = await this.executeCommand(
      input.requestId,
      input.commandId,
      input.deadlineAt,
      input.command
    );
    if (!completed) return false;
    this.commandCount += 1;
    if (this.once && this.commandCount >= 1) {
      await this.shutdown();
      return false;
    }
    return true;
  }

  public async closeInput(): Promise<void> {
    if (!this.closing) await this.shutdown();
  }

  private async initialize(
    bootstrap: RuntimeBootstrap,
    resumeCursor: number
  ): Promise<boolean> {
    try {
      this.lastCursor = resumeCursor;
      this.runtimeInstanceId = bootstrap.runtimeInstanceId;
      const ready = await this.ingress.initialize({
        bootstrap,
        hostCapabilities: {
          request: async (operation) => {
            throw new Error(`headless_host_capability_unavailable:${operation.kind}`);
          }
        },
        emitEvent: (event) => this.onRuntimeEvent(event)
      });
      this.send({
        type: 'ready',
        protocolVersion: '3.0',
        status: ready.status,
        resumeCursor
      });
      this.initialized = true;
      for (const event of this.bufferedEvents.sort(
        (left, right) => left.cursor - right.cursor
      )) {
        this.deliverEvent(event);
      }
      this.bufferedEvents = [];
      return true;
    } catch (error) {
      const message = error instanceof RuntimeIngressInitializationError
        ? error.publicMessage
        : 'Headless Runtime initialization failed.';
      const code = error instanceof RuntimeIngressInitializationError
        ? normalizeErrorCode(error.code)
        : 'headless_initialization_failed';
      this.logLine(`[runtime] initialization failed: ${code}`);
      return this.fail('headless_initialization_failed', message, 3);
    }
  }

  private async executeCommand(
    requestId: string,
    commandId: string,
    deadlineAt: string,
    command: RuntimeCommand
  ): Promise<boolean> {
    try {
      const outcome = await this.executeIngress(
        requestId,
        commandId,
        deadlineAt,
        command
      );
      this.send({ type: 'response', requestId, outcome });
      return true;
    } catch {
      return this.fail(
        'headless_ingress_failed',
        'Headless Runtime could not safely settle the command.',
        4
      );
    }
  }

  private async executeForResult(
    correlationId: string,
    commandId: string,
    deadlineAt: string,
    command: RuntimeCommand
  ): Promise<RuntimeResult> {
    const outcome = await this.executeIngress(
      correlationId,
      commandId,
      deadlineAt,
      command
    );
    if (outcome.ok) return outcome.result;
    throw new Error(outcome.error.code);
  }

  private async executeIngress(
    correlationId: string,
    commandId: string,
    deadlineAt: string,
    command: RuntimeCommand
  ) {
    const controller = new AbortController();
    return this.ingress.execute({
      commandId,
      correlationId,
      command,
      deadlineAt,
      signal: controller.signal
    });
  }

  private onRuntimeEvent(event: RuntimeEventEnvelope): void {
    if (!this.initialized) {
      this.bufferedEvents.push(event);
      return;
    }
    this.deliverEvent(event);
  }

  private deliverEvent(event: RuntimeEventEnvelope): void {
    if (event.cursor <= this.lastCursor) return;
    if (this.lastCursor > 0 && event.cursor !== this.lastCursor + 1) {
      throw new Error(
        `headless_event_cursor_gap:${String(this.lastCursor)}:${String(event.cursor)}`
      );
    }
    this.lastCursor = event.cursor;
    this.send({ type: 'event', event });
  }

  private send(output: HeadlessOutput): void {
    const validated = parseHeadlessOutput(output);
    this.writeLine(JSON.stringify(validated));
  }

  private async fail(
    code: string,
    message: string,
    exitCode: number
  ): Promise<false> {
    this.exitCode = exitCode;
    this.send({
      type: 'fatal',
      code: normalizeErrorCode(code),
      message: message.slice(0, 4_096),
      retryable: false
    });
    await this.shutdown();
    return false;
  }

  private async shutdown(deadlineAt = Date.now() + 10_000): Promise<boolean> {
    if (this.closing) return this.exitCode === 0;
    this.closing = true;
    const context = createShutdownContext(deadlineAt);
    try {
      await this.ingress.shutdown(context);
      context.throwIfExpired();
      return true;
    } catch {
      this.logLine('[runtime] headless shutdown failed: runtime_shutdown_failed');
      if (this.exitCode === 0) this.exitCode = 4;
      return false;
    } finally {
      context.dispose();
    }
  }
}

function normalizeErrorCode(code: string): string {
  const normalized = code.toLowerCase().replace(/[^a-z0-9_]+/gu, '_');
  return /^[a-z][a-z0-9_]{1,127}$/u.test(normalized)
    ? normalized
    : 'headless_runtime_error';
}
