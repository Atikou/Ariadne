import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { FrameDecoder, writeFrame } from '../src/protocol.mjs';

test('length-prefixed JSON decoder accepts fragmented and combined frames', async () => {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  writeFrame(output, { id: 1 });
  writeFrame(output, { id: 2 });
  const encoded = Buffer.concat(chunks);
  const decoder = new FrameDecoder();
  const messages = [];
  decoder.on('message', (message) => messages.push(message));
  decoder.accept(encoded.subarray(0, 3));
  decoder.accept(encoded.subarray(3, 11));
  decoder.accept(encoded.subarray(11));
  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }]);
});

test('decoder rejects oversized frames', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(2 * 1024 * 1024 + 1);
  assert.throws(() => new FrameDecoder().accept(header), /frame_invalid/u);
});
