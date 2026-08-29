import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export class FrameDecoder extends EventEmitter {
  #buffer = Buffer.alloc(0);

  accept(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME_BYTES) throw new Error('frame_invalid');
      if (this.#buffer.length < 4 + length) return;
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      this.emit('message', JSON.parse(body.toString('utf8')));
    }
  }
}

export function writeFrame(stream, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length === 0 || body.length > MAX_FRAME_BYTES) throw new Error('frame_too_large');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  stream.write(Buffer.concat([header, body]));
}
