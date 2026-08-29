import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  MAX_IMAGE_ATTACHMENT_DIMENSION_V3,
  MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES_V3,
  MAX_IMAGE_ATTACHMENT_PIXELS_V3,
  MAX_IMAGE_ATTACHMENT_SOURCE_BYTES_V3,
  encodedImageAttachmentV3Schema,
  imageAttachmentRefV3Schema,
  type EncodedImageAttachmentV3,
  type ImageAttachmentRefV3
} from '@ariadne/protocol/public';
import sharp from 'sharp';

import type {
  ConversationAttachmentStore,
  StoredConversationImageAttachment
} from '../../control/ports/ConversationAttachmentStore.js';

const NORMALIZED_MAX_DIMENSION = 2_048;
const NORMALIZED_MAX_PIXELS = 2_048 * 2_048;
const NORMALIZED_MAX_BYTES = 1536 * 1024;
const QUALITY_LADDER = [90, 82, 74, 66, 58, 50] as const;

interface PreparedImage {
  readonly ref: ImageAttachmentRefV3;
  readonly bytes: Buffer;
}

/** Content-addressed, verified image store used only by the v3 Conversation path. */
export class LocalConversationAttachmentStore implements ConversationAttachmentStore {
  private readonly root: string;

  public constructor(dataRoot: string) {
    if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) {
      throw new Error('conversation_attachment_data_root_invalid');
    }
    this.root = path.resolve(dataRoot, 'data', 'conversation', 'attachments', 'v1');
  }

  public async saveImages(
    inputs: readonly EncodedImageAttachmentV3[],
    signal?: AbortSignal
  ): Promise<readonly ImageAttachmentRefV3[]> {
    signal?.throwIfAborted();
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > 4) {
      throw attachmentError('batch_invalid');
    }
    const parsed = inputs.map((input) => {
      const result = encodedImageAttachmentV3Schema.safeParse(input);
      if (!result.success) throw attachmentError('input_invalid', result.error);
      return result.data;
    });
    const sourceBytes = parsed.map((input) => decodeCanonicalBase64(input.data));
    if (sourceBytes.reduce((sum, bytes) => sum + bytes.byteLength, 0)
      > MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES_V3) {
      throw attachmentError('batch_too_large');
    }

    // Every member is fully decoded and normalized before any object is published.
    const prepared = await Promise.all(parsed.map((input, index) => (
      prepareImage(input, sourceBytes[index]!, signal)
    )));
    if (prepared.reduce((sum, image) => sum + image.bytes.byteLength, 0)
      > MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES_V3) {
      throw attachmentError('normalized_batch_too_large');
    }
    signal?.throwIfAborted();
    for (const image of prepared) await this.commit(image, signal);
    return Object.freeze(prepared.map((image) => Object.freeze({ ...image.ref })));
  }

  public async readImage(
    rawRef: ImageAttachmentRefV3,
    signal?: AbortSignal
  ): Promise<StoredConversationImageAttachment> {
    signal?.throwIfAborted();
    const parsed = imageAttachmentRefV3Schema.safeParse(rawRef);
    if (!parsed.success) throw attachmentError('reference_invalid', parsed.error);
    const ref = parsed.data;
    const data = await readFile(this.objectPath(ref.attachmentId));
    signal?.throwIfAborted();
    if (data.byteLength !== ref.bytes || attachmentId(data) !== ref.attachmentId) {
      throw attachmentError('object_digest_mismatch');
    }
    const metadata = await inspectImage(data);
    if (
      metadata.mediaType !== ref.mediaType
      || metadata.width !== ref.width
      || metadata.height !== ref.height
    ) throw attachmentError('object_metadata_mismatch');
    return Object.freeze({ ref: Object.freeze({ ...ref }), data: Uint8Array.from(data) });
  }

  private async commit(image: PreparedImage, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const target = this.objectPath(image.ref.attachmentId);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(image.bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      signal?.throwIfAborted();
      try {
        await rename(temporary, target);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await rm(temporary, { force: true });
      }
      const stored = await readFile(target);
      if (stored.byteLength !== image.bytes.byteLength
        || attachmentId(stored) !== image.ref.attachmentId) {
        throw attachmentError('object_commit_verification_failed');
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private objectPath(id: string): string {
    if (!/^sha256:[a-f0-9]{64}$/u.test(id)) throw attachmentError('id_invalid');
    const hash = id.slice('sha256:'.length);
    const resolved = path.resolve(this.root, 'objects', hash.slice(0, 2), hash);
    const relative = path.relative(path.resolve(this.root), resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw attachmentError('path_escape');
    }
    return resolved;
  }
}

async function prepareImage(
  input: EncodedImageAttachmentV3,
  bytes: Buffer,
  signal?: AbortSignal
): Promise<PreparedImage> {
  signal?.throwIfAborted();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_ATTACHMENT_SOURCE_BYTES_V3) {
    throw attachmentError('source_size_invalid');
  }
  const source = await inspectImage(bytes);
  if (source.mediaType !== input.mediaType) throw attachmentError('media_type_mismatch');
  if (
    source.width > MAX_IMAGE_ATTACHMENT_DIMENSION_V3
    || source.height > MAX_IMAGE_ATTACHMENT_DIMENSION_V3
    || source.width * source.height > MAX_IMAGE_ATTACHMENT_PIXELS_V3
  ) throw attachmentError('source_dimensions_invalid');

  const scale = Math.min(
    1,
    NORMALIZED_MAX_DIMENSION / Math.max(source.width, source.height),
    Math.sqrt(NORMALIZED_MAX_PIXELS / (source.width * source.height))
  );
  const width = Math.max(1, Math.floor(source.width * scale));
  const height = Math.max(1, Math.floor(source.height * scale));
  const hasAlpha = source.hasAlpha;
  let smallest: Buffer | undefined;
  for (const quality of QUALITY_LADDER) {
    signal?.throwIfAborted();
    const pipeline = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_IMAGE_ATTACHMENT_PIXELS_V3 })
      .rotate()
      .resize({ width, height, fit: 'inside', withoutEnlargement: true })
      .toColorspace('srgb');
    const candidate = hasAlpha
      ? await pipeline.webp({ quality, alphaQuality: quality, effort: 4 }).toBuffer()
      : await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    smallest = candidate;
    if (candidate.byteLength <= NORMALIZED_MAX_BYTES) break;
  }
  if (smallest === undefined || smallest.byteLength > NORMALIZED_MAX_BYTES) {
    throw attachmentError('normalized_size_invalid');
  }
  const normalized = await inspectImage(smallest);
  const id = attachmentId(smallest);
  const ref: ImageAttachmentRefV3 = {
    attachmentId: id,
    mediaType: normalized.mediaType,
    bytes: smallest.byteLength,
    width: normalized.width,
    height: normalized.height,
    ...(input.name === undefined ? {} : { name: sanitizeName(input.name) }),
    ...(normalized.width === source.width && normalized.height === source.height
      ? {}
      : { originalDimensions: { width: source.width, height: source.height } })
  };
  return { ref: imageAttachmentRefV3Schema.parse(ref), bytes: smallest };
}

async function inspectImage(bytes: Buffer): Promise<{
  readonly mediaType: ImageAttachmentRefV3['mediaType'];
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
}> {
  let metadata;
  try {
    metadata = await sharp(bytes, {
      failOn: 'warning',
      limitInputPixels: MAX_IMAGE_ATTACHMENT_PIXELS_V3
    }).metadata();
  } catch (error) {
    throw attachmentError('decode_failed', error);
  }
  const mediaType = metadata.format === 'png'
    ? 'image/png' as const
    : metadata.format === 'jpeg'
      ? 'image/jpeg' as const
      : metadata.format === 'webp'
        ? 'image/webp' as const
        : undefined;
  if (
    mediaType === undefined
    || metadata.width === undefined
    || metadata.height === undefined
    || !Number.isSafeInteger(metadata.width)
    || !Number.isSafeInteger(metadata.height)
    || metadata.width < 1
    || metadata.height < 1
  ) throw attachmentError('metadata_invalid');
  return {
    mediaType,
    width: metadata.width,
    height: metadata.height,
    hasAlpha: metadata.hasAlpha === true
  };
}

function decodeCanonicalBase64(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw attachmentError('base64_noncanonical');
  return bytes;
}

function sanitizeName(value: string): string {
  const normalized = path.basename(value.replaceAll('\\', '/')).trim();
  if (normalized.length === 0) return 'image';
  return normalized.slice(0, 256);
}

function attachmentId(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function attachmentError(code: string, cause?: unknown): Error {
  return new Error(`conversation_attachment_${code}`, { cause });
}
