import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';

import { LocalConversationAttachmentStore } from '../src/adapters/attachment/LocalConversationAttachmentStore.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => import('node:fs/promises').then(
    ({ rm }) => rm(root, { recursive: true, force: true })
  )));
});

describe('LocalConversationAttachmentStore', () => {
  it('normalizes, deduplicates and verifies immutable image bytes', async () => {
    const root = await temporaryRoot();
    const store = new LocalConversationAttachmentStore(root);
    const source = await sharp({
      create: { width: 8, height: 6, channels: 4, background: '#336699cc' }
    }).png().toBuffer();
    const input = {
      mediaType: 'image/png' as const,
      data: source.toString('base64'),
      name: 'C:\\private\\sample.png'
    };

    const [first] = await store.saveImages([input]);
    const [second] = await store.saveImages([input]);

    expect(first).toEqual(second);
    expect(first?.name).toBe('sample.png');
    expect(first?.attachmentId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const stored = await store.readImage(first!);
    expect(stored.data.byteLength).toBe(first?.bytes);
    expect(stored.ref).toEqual(first);
  });

  it('validates every batch member before publishing an object', async () => {
    const root = await temporaryRoot();
    const store = new LocalConversationAttachmentStore(root);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: '#000000' }
    }).png().toBuffer();

    await expect(store.saveImages([
      { mediaType: 'image/png', data: png.toString('base64') },
      { mediaType: 'image/jpeg', data: png.toString('base64') }
    ])).rejects.toThrow('conversation_attachment_media_type_mismatch');
    await expect(readFile(path.join(root, 'data', 'conversation', 'attachments', 'v1')))
      .rejects.toThrow();
  });

  it('fails closed when content-addressed bytes are corrupted', async () => {
    const root = await temporaryRoot();
    const store = new LocalConversationAttachmentStore(root);
    const png = await sharp({
      create: { width: 3, height: 3, channels: 3, background: '#ffffff' }
    }).png().toBuffer();
    const [ref] = await store.saveImages([
      { mediaType: 'image/png', data: png.toString('base64') }
    ]);
    const hash = ref!.attachmentId.slice('sha256:'.length);
    const object = path.join(
      root, 'data', 'conversation', 'attachments', 'v1', 'objects', hash.slice(0, 2), hash
    );
    await mkdir(path.dirname(object), { recursive: true });
    await writeFile(object, Buffer.from('corrupt'));

    await expect(store.readImage(ref!))
      .rejects.toThrow('conversation_attachment_object_digest_mismatch');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await import('node:fs/promises').then(({ mkdtemp }) => (
    mkdtemp(path.join(os.tmpdir(), 'ariadne-attachment-store-'))
  ));
  roots.push(root);
  return root;
}
