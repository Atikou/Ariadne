import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';

const HEADER_BYTES = 4;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export class FramedJsonDecoder extends EventEmitter {
  private pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  accept(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= HEADER_BYTES) {
      const length = this.pending.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.emit('error', new Error('speech_protocol_frame_invalid'));
        this.pending = Buffer.alloc(0);
        return;
      }
      if (this.pending.length < HEADER_BYTES + length) return;
      const body = this.pending.subarray(HEADER_BYTES, HEADER_BYTES + length);
      this.pending = this.pending.subarray(HEADER_BYTES + length);
      try {
        this.emit('message', JSON.parse(body.toString('utf8')) as unknown);
      } catch {
        this.emit('error', new Error('speech_protocol_json_invalid'));
      }
    }
  }
}

export function writeFramedJson(stream: Writable, message: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) {
    return Promise.reject(new Error('speech_protocol_frame_too_large'));
  }
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(body.length, 0);
  const frame = Buffer.concat([header, body]);
  return new Promise((resolve, reject) => {
    stream.write(frame, (error) => error ? reject(error) : resolve());
  });
}
