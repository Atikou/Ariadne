import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  type WriteStream,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { redactValue } from "../util/redact.js";
import { gzipTraceSegmentInPlace } from "../util/traceSegmentIo.js";
import { migrateLegacyTraceFile } from "./traceCatalog.js";
import { ACTIVE_SEGMENT_PATH, TraceIndexStore } from "./TraceIndexStore.js";
import {
  nextSegmentRelPath,
  resolveTracePaths,
  type TracePathLayout,
} from "./tracePaths.js";

export interface TraceEvent {
  type: string;
  [key: string]: unknown;
}

export interface PreparedTraceEvent {
  eventId: string;
  time: string;
  payload: TraceEvent;
  line: string;
  lineBytes: number;
}

export function prepareTraceEvent(event: TraceEvent, redact = true): PreparedTraceEvent {
  const eventId = randomUUID();
  const time = new Date().toISOString();
  const payload = (redact ? redactValue(event) : event) as TraceEvent;
  const line = `${JSON.stringify({ time, eventId, ...payload })}\n`;
  return {
    eventId,
    time,
    payload,
    line,
    lineBytes: Buffer.byteLength(line, "utf-8"),
  };
}

export interface TraceRotationPolicy {
  rotationMaxBytes: number;
  rotationMaxAgeHours: number;
  /** 轮转后将旧 segment gzip 为 `.jsonl.gz`（默认 false，由 lifecycle policy 注入）。 */
  compressOldSegments?: boolean;
}

export interface TraceLoggerOptions {
  /** 写入前脱敏（默认 true）。 */
  redact?: boolean;
  /** 分段模式：传入 traces 根目录。 */
  tracesDir?: string;
  rotation?: TraceRotationPolicy;
  index?: TraceIndexStore;
  /** 审计写入失败通知；回调异常同样不会传播到业务调用方。 */
  onWriteError?: (error: unknown) => void;
}

export interface TraceWriteHealth {
  failedWrites: number;
  lastFailureAt?: string;
  lastErrorCode?: string;
}

/**
 * 追加式 JSONL 事件日志。支持单文件（兼容）与 active + segments 分段写入。
 */
export class TraceLogger {
  private readonly redact: boolean;
  private readonly layout?: TracePathLayout;
  private readonly index?: TraceIndexStore;
  private readonly rotation?: TraceRotationPolicy;
  private readonly segmented: boolean;
  private stream?: WriteStream;
  private fd?: number;
  private activePath: string;
  private activeRel: string;
  private bytesWritten = 0;
  private openedAt = Date.now();
  private closed = false;
  // 防止 write()→maybeRotate() 与显式 rotate() 在同一段上重入造成 fd/重命名错乱。
  private rotating = false;
  private failedWrites = 0;
  private lastFailureAt?: string;
  private lastErrorCode?: string;
  private readonly onWriteError?: (error: unknown) => void;

  constructor(traceFileOrDir: string, options: TraceLoggerOptions = {}) {
    this.redact = options.redact !== false;
    this.index = options.index;
    this.rotation = options.rotation;
    this.onWriteError = options.onWriteError;
    this.segmented = !!options.tracesDir;

    if (options.tracesDir) {
      this.layout = resolveTracePaths(options.tracesDir);
      mkdirSync(path.dirname(this.layout.activeFile), { recursive: true });
      mkdirSync(this.layout.segmentsDir, { recursive: true });
      migrateLegacyTraceFile({ tracesDir: options.tracesDir, index: this.index });
      this.activePath = this.layout.activeFile;
      this.activeRel = ACTIVE_SEGMENT_PATH;
      this.fd = openSync(this.activePath, "a");
      if (existsSync(this.activePath)) {
        this.bytesWritten = statSync(this.activePath).size;
      }
    } else {
      this.activePath = traceFileOrDir;
      this.activeRel = path.basename(traceFileOrDir);
      mkdirSync(path.dirname(traceFileOrDir), { recursive: true });
      this.stream = createWriteStream(traceFileOrDir, { flags: "a", encoding: "utf-8" });
      this.stream.on("error", (error) => this.recordWriteFailure(error));
      if (existsSync(traceFileOrDir)) {
        this.bytesWritten = statSync(traceFileOrDir).size;
      }
    }
  }

  getTracesDir(): string | undefined {
    return this.layout?.tracesDir;
  }

  getActiveFile(): string {
    return this.activePath;
  }

  getIndexStore(): TraceIndexStore | undefined {
    return this.index;
  }

  getWriteHealth(): TraceWriteHealth {
    return {
      failedWrites: this.failedWrites,
      lastFailureAt: this.lastFailureAt,
      lastErrorCode: this.lastErrorCode,
    };
  }

  write(event: TraceEvent): void {
    if (this.closed) return;
    try {
      this.writeEvent(event);
    } catch (error) {
      this.recordWriteFailure(error);
    }
  }

  private writeEvent(event: TraceEvent): void {
    this.maybeRotate();
    const prepared = prepareTraceEvent(event, this.redact);

    if (this.segmented && this.fd != null) {
      appendFileSync(this.fd, prepared.line, "utf-8");
    } else if (this.stream) {
      this.stream.write(prepared.line);
    }
    this.bytesWritten += prepared.lineBytes;

    if (this.index && this.layout) {
      const e = prepared.payload as Record<string, unknown>;
      this.index.insert({
        eventId: prepared.eventId,
        ts: Date.parse(prepared.time),
        runId: typeof e.runId === "string" ? e.runId : undefined,
        sessionId: typeof e.sessionId === "string" ? e.sessionId : undefined,
        eventType: String(e.type ?? "unknown"),
        status: typeof e.status === "string" ? e.status : undefined,
        segmentPath: this.activeRel,
        redacted: this.redact,
      });
    }
  }

  private recordWriteFailure(error: unknown): void {
    this.failedWrites += 1;
    this.lastFailureAt = new Date().toISOString();
    this.lastErrorCode = "TRACE_WRITE_FAILED";
    try {
      if (typeof error === "object" && error && "code" in error) {
        this.lastErrorCode = String(
          (error as { code?: unknown }).code ?? "TRACE_WRITE_FAILED",
        );
      }
    } catch {
      // Keep the stable fallback code even for malformed error objects.
    }
    try {
      this.onWriteError?.(error);
    } catch {
      // Observability callbacks must never become a business control-flow edge.
    }
  }

  /** 显式轮转 active 段。 */
  rotate(opts?: { force?: boolean }): { rotated: boolean; segmentPath?: string } {
    if (!this.layout || this.closed) return { rotated: false };
    if (!opts?.force && !this.shouldRotate()) return { rotated: false };
    return this.performRotation();
  }

  private maybeRotate(): void {
    if (!this.layout || !this.rotation) return;
    if (!this.shouldRotate()) return;
    this.performRotation();
  }

  private performRotation(): { rotated: boolean; segmentPath?: string } {
    if (!this.layout || this.bytesWritten === 0 || this.rotating) return { rotated: false };
    this.rotating = true;
    try {
      const segRel = nextSegmentRelPath(this.layout.tracesDir).replace(/\\/g, "/");
      const segAbs = path.join(this.layout.tracesDir, segRel);
      mkdirSync(path.dirname(segAbs), { recursive: true });

      if (this.fd != null) {
        closeSync(this.fd);
        this.fd = undefined;
      }
      if (existsSync(this.activePath)) {
        renameSync(this.activePath, segAbs);
      }
      if (this.index) {
        this.index.reassignSegment(this.activeRel, segRel);
      }

      let finalSegRel = segRel;
      if (this.rotation?.compressOldSegments && existsSync(segAbs)) {
        gzipTraceSegmentInPlace(segAbs);
        finalSegRel = `${segRel}.gz`;
        if (this.index) {
          this.index.reassignSegment(segRel, finalSegRel);
        }
      }

      this.activeRel = ACTIVE_SEGMENT_PATH;
      this.activePath = this.layout.activeFile;
      this.bytesWritten = 0;
      this.openedAt = Date.now();
      this.fd = openSync(this.activePath, "a");
      return { rotated: true, segmentPath: finalSegRel };
    } finally {
      this.rotating = false;
    }
  }

  private shouldRotate(): boolean {
    if (!this.rotation) return false;
    if (this.bytesWritten >= this.rotation.rotationMaxBytes) return true;
    const ageHours = (Date.now() - this.openedAt) / (60 * 60 * 1000);
    return ageHours >= this.rotation.rotationMaxAgeHours;
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;

    if (this.layout && this.bytesWritten > 0) {
      this.performRotation();
    } else if (this.fd != null) {
      closeSync(this.fd);
      this.fd = undefined;
    }

    if (this.stream) {
      return new Promise((resolve) => this.stream!.end(() => resolve()));
    }
    return Promise.resolve();
  }
}

/** 工厂：从 traces 目录创建带索引的分段 TraceLogger。 */
export function createSegmentedTraceLogger(
  tracesDir: string,
  rotation: TraceRotationPolicy,
): { logger: TraceLogger; index: TraceIndexStore } {
  const layout = resolveTracePaths(tracesDir);
  const index = new TraceIndexStore(layout.indexDbPath);
  const logger = new TraceLogger(tracesDir, { tracesDir, rotation, index });
  return { logger, index };
}
