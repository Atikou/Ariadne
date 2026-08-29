const DEFAULT_MAX_EVENT_BYTES = 64 * 1_024;

/**
 * Incremental UTF-8 SSE framing. It exposes only joined `data:` payloads and
 * deliberately ignores event names, ids, retries, and comments so Provider
 * wire metadata cannot become inference authority.
 */
export class ServerSentEventDataDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly maxEventBytes: number;
  private buffer = '';
  private dataLines: string[] = [];
  private eventBytes = 0;
  private finished = false;

  public constructor(maxEventBytes = DEFAULT_MAX_EVENT_BYTES) {
    if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes <= 0) {
      throw new Error('agent_model_provider_sse_limit_invalid');
    }
    this.maxEventBytes = maxEventBytes;
  }

  public push(bytes: Uint8Array): readonly string[] {
    if (this.finished) throw new Error('agent_model_provider_sse_already_finished');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return [];
    let decoded: string;
    try {
      decoded = this.decoder.decode(bytes, { stream: true });
    } catch {
      throw new Error('agent_model_provider_sse_utf8_invalid');
    }
    this.buffer += decoded;
    return this.drainLines(false);
  }

  public finish(): readonly string[] {
    if (this.finished) throw new Error('agent_model_provider_sse_already_finished');
    this.finished = true;
    try {
      this.buffer += this.decoder.decode();
    } catch {
      throw new Error('agent_model_provider_sse_utf8_invalid');
    }
    const events = this.drainLines(true);
    if (this.dataLines.length > 0) events.push(this.emitEvent());
    return events;
  }

  private drainLines(flushRemainder: boolean): string[] {
    const events: string[] = [];
    while (true) {
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd < 0) break;
      let line = this.buffer.slice(0, lineEnd);
      this.buffer = this.buffer.slice(lineEnd + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.consumeLine(line, events);
    }
    if (flushRemainder && this.buffer.length > 0) {
      let line = this.buffer;
      this.buffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.consumeLine(line, events);
    }
    this.assertBounded(this.buffer);
    return events;
  }

  private consumeLine(line: string, events: string[]): void {
    this.assertBounded(line);
    if (line.length === 0) {
      if (this.dataLines.length > 0) events.push(this.emitEvent());
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    if (field !== 'data') return;
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    const bytes = Buffer.byteLength(value, 'utf8');
    const separatorBytes = this.dataLines.length === 0 ? 0 : 1;
    if (this.eventBytes + separatorBytes + bytes > this.maxEventBytes) {
      throw new Error('agent_model_provider_sse_event_too_large');
    }
    this.dataLines.push(value);
    this.eventBytes += separatorBytes + bytes;
  }

  private emitEvent(): string {
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    this.eventBytes = 0;
    return data;
  }

  private assertBounded(value: string): void {
    if (Buffer.byteLength(value, 'utf8') > this.maxEventBytes) {
      throw new Error('agent_model_provider_sse_event_too_large');
    }
  }
}
