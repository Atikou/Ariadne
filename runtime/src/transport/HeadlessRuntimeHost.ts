import {
  parseHeadlessInput,
  parseHeadlessOutput,
  type HeadlessOutput,
} from "@ariadne/protocol/headless";
import type { RuntimeEventEnvelope } from "@ariadne/protocol/public";
import type { RuntimeBootstrap } from "@ariadne/protocol/host";

import type { AppContext } from "../app/createAppContext.js";
import { RuntimeFacade, RuntimeFacadeError } from "../application/RuntimeFacade.js";
import { createRuntimeContext } from "../application/createRuntimeContext.js";
import { toPublicError } from "../util/publicError.js";

const MAX_NDJSON_LINE_BYTES = 2 * 1024 * 1024;

export interface HeadlessRuntimeHostOptions {
  once?: boolean;
  createContext?: (bootstrap: RuntimeBootstrap) => AppContext;
  write?: (line: string) => void;
  log?: (line: string) => void;
}

/**
 * Portless CI/headless adapter over the same RuntimeFacade used by Electron.
 * stdout is owned by validated NDJSON messages; diagnostics are delegated to stderr.
 */
export class HeadlessRuntimeHost {
  private readonly createContext: (bootstrap: RuntimeBootstrap) => AppContext;
  private readonly writeLine: (line: string) => void;
  private readonly logLine: (line: string) => void;
  private readonly once: boolean;
  private app?: AppContext;
  private facade?: RuntimeFacade;
  private initialized = false;
  private closing = false;
  private commandCount = 0;
  private lastCursor = 0;
  private bufferedEvents: RuntimeEventEnvelope[] = [];
  exitCode = 0;

  constructor(options: HeadlessRuntimeHostOptions = {}) {
    this.once = options.once ?? false;
    this.createContext = options.createContext ?? ((bootstrap) => createRuntimeContext(bootstrap));
    this.writeLine = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    this.logLine = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  async handleLine(line: string): Promise<boolean> {
    if (this.closing) return false;
    if (Buffer.byteLength(line, "utf8") > MAX_NDJSON_LINE_BYTES) {
      return this.fail("ndjson_line_too_large", "NDJSON input exceeds the 2 MiB limit.", 2);
    }
    let input;
    try {
      input = parseHeadlessInput(JSON.parse(line));
    } catch {
      return this.fail("ndjson_input_invalid", "Invalid Ariadne headless protocol input.", 2);
    }

    if (input.type === "hello") {
      if (this.initialized || this.app) {
        return this.fail("duplicate_hello", "Headless Runtime was already initialized.", 2);
      }
      return this.initialize(input.bootstrap, input.resumeCursor);
    }
    if (!this.initialized || !this.facade) {
      return this.fail("hello_required", "The first headless message must be hello.", 2);
    }
    if (input.type === "shutdown") {
      this.send({
        type: "response",
        requestId: input.requestId,
        outcome: { ok: true, result: { kind: "acknowledged" } },
      });
      await this.shutdown();
      return false;
    }

    await this.executeCommand(input.requestId, input.command);
    this.commandCount += 1;
    if (this.once && this.commandCount >= 1) {
      await this.shutdown();
      return false;
    }
    return true;
  }

  async closeInput(): Promise<void> {
    if (!this.closing) await this.shutdown();
  }

  private async initialize(bootstrap: RuntimeBootstrap, resumeCursor: number): Promise<boolean> {
    try {
      this.lastCursor = resumeCursor;
      this.app = this.createContext(bootstrap);
      this.facade = new RuntimeFacade(
        this.app,
        (event) => this.onRuntimeEvent(event),
        bootstrap.runtimeVersion,
        {
          conversationWorkspaceStateFile: `${bootstrap.dataRoot}/conversation-workspaces.json`,
          workspaces: bootstrap.workspaces,
          ...(bootstrap.agentPermissions ? {
            proposalApproval: bootstrap.agentPermissions.proposalApproval,
            allowedPermissions: bootstrap.agentPermissions.allowedPermissions,
          } : {}),
        },
      );
      await this.app.start();
      await this.facade.start();
      this.send({
        type: "ready",
        protocolVersion: "2.0",
        status: this.facade.status(),
        resumeCursor,
      });
      await this.replay(resumeCursor);
      this.initialized = true;
      for (const event of this.bufferedEvents.sort((left, right) => left.cursor - right.cursor)) {
        this.deliverEvent(event);
      }
      this.bufferedEvents = [];
      return true;
    } catch (error) {
      const failure = toPublicError(error, "Headless Runtime initialization failed.");
      this.logLine(`[runtime] initialization failed: ${failure.code}`);
      return this.fail(
        "headless_initialization_failed",
        failure.message,
        3,
      );
    }
  }

  private async replay(afterCursor: number): Promise<void> {
    const facade = this.facade;
    if (!facade) return;
    let cursor = afterCursor;
    while (true) {
      const result = await facade.handle({
        kind: "events.replay",
        afterCursor: cursor,
        limit: 2_000,
      });
      if (result.kind !== "events.replay") throw new Error("headless_replay_invalid");
      for (const event of result.events) this.deliverEvent(event);
      if (result.events.length < 2_000 || result.nextCursor <= cursor) break;
      cursor = result.nextCursor;
    }
  }

  private async executeCommand(
    requestId: string,
    command: Parameters<RuntimeFacade["handle"]>[0],
  ): Promise<void> {
    try {
      const result = await this.facade!.handle(command);
      this.send({ type: "response", requestId, outcome: { ok: true, result } });
    } catch (error) {
      if (error instanceof RuntimeFacadeError) {
        this.send({
          type: "response",
          requestId,
          outcome: {
            ok: false,
            error: {
              code: normalizeErrorCode(error.code),
              message: error.message.slice(0, 4_096),
              retryable: error.retryable,
            },
          },
        });
        return;
      }
      const failure = toPublicError(error, "Headless Runtime command failed.");
      this.send({
        type: "response",
        requestId,
        outcome: {
          ok: false,
          error: {
            code: normalizeErrorCode(failure.code.toLowerCase()),
            message: failure.message.slice(0, 4_096),
            retryable: false,
          },
        },
      });
    }
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
      throw new Error(`headless_event_cursor_gap:${this.lastCursor}:${event.cursor}`);
    }
    this.lastCursor = event.cursor;
    this.send({ type: "event", event });
  }

  private send(output: HeadlessOutput): void {
    const validated = parseHeadlessOutput(output);
    this.writeLine(JSON.stringify(validated));
  }

  private async fail(
    code: string,
    message: string,
    exitCode: number,
  ): Promise<false> {
    this.exitCode = exitCode;
    this.send({
      type: "fatal",
      code: normalizeErrorCode(code),
      message: message.slice(0, 4_096),
      retryable: false,
    });
    await this.shutdown();
    return false;
  }

  private async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    try {
      await this.facade?.stop();
      await this.app?.prepareShutdown();
      await this.app?.shutdown();
    } catch (error) {
      this.logLine(`[runtime] headless shutdown failed: ${toPublicError(error, "shutdown_failed").code}`);
      if (this.exitCode === 0) this.exitCode = 4;
    }
  }
}

function normalizeErrorCode(code: string): string {
  const normalized = code.toLowerCase().replace(/[^a-z0-9_]+/gu, "_");
  return /^[a-z][a-z0-9_]{1,127}$/u.test(normalized)
    ? normalized
    : "headless_runtime_error";
}
