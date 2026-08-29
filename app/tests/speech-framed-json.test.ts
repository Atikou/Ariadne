import { Buffer } from 'node:buffer';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FramedJsonDecoder, writeFramedJson } from '../src/main/speech/framed-json';

describe('speech framed JSON protocol', () => {
  it('decodes fragmented and coalesced messages', async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    await writeFramedJson(stream, { value: 1 });
    await writeFramedJson(stream, { value: 2 });
    const encoded = Buffer.concat(chunks);
    const decoder = new FramedJsonDecoder();
    const messages: unknown[] = [];
    decoder.on('message', (message) => messages.push(message));
    decoder.accept(encoded.subarray(0, 2));
    decoder.accept(encoded.subarray(2, 9));
    decoder.accept(encoded.subarray(9));
    expect(messages).toEqual([{ value: 1 }, { value: 2 }]);
  });

  it('rejects oversized frames', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(2 * 1024 * 1024 + 1);
    const decoder = new FramedJsonDecoder();
    const failures: Error[] = [];
    decoder.on('error', (error: Error) => { failures.push(error); });
    decoder.accept(header);
    expect(failures.map((error) => error.message)).toEqual(['speech_protocol_frame_invalid']);
  });
});
