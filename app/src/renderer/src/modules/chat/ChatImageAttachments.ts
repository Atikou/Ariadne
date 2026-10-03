import type { EncodedImageAttachmentV3 } from '@ariadne/protocol/public';
import {
  IMAGE_ATTACHMENT_MEDIA_TYPES_V3,
  MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3,
  MAX_IMAGE_ATTACHMENT_SOURCE_BYTES_V3
} from '@ariadne/protocol/public';

export interface DraftImageAttachment extends EncodedImageAttachmentV3 {
  readonly clientId: string;
  readonly bytes: number;
}

export async function encodeDraftImages(files: FileList): Promise<readonly DraftImageAttachment[]> {
  const selected = Array.from(files);
  if (selected.length > MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3) {
    throw new Error(`每条消息最多添加 ${MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3} 张图片。`);
  }
  return Promise.all(selected.map(async (file) => {
    if (!IMAGE_ATTACHMENT_MEDIA_TYPES_V3.includes(
      file.type as (typeof IMAGE_ATTACHMENT_MEDIA_TYPES_V3)[number]
    )) {
      throw new Error(`不支持 ${file.name || '所选文件'} 的图片格式。`);
    }
    if (file.size < 1 || file.size > MAX_IMAGE_ATTACHMENT_SOURCE_BYTES_V3) {
      throw new Error(`${file.name || '图片'} 必须小于 2 MB。`);
    }
    const mediaType = file.type as EncodedImageAttachmentV3['mediaType'];
    const data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    const normalizedName = file.name.trim().slice(0, 256);
    return {
      clientId: crypto.randomUUID(),
      mediaType,
      data,
      bytes: file.size,
      ...(normalizedName.length === 0 ? {} : { name: normalizedName })
    };
  }));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function formatBytes(bytes: number): string {
  return bytes < 1_024
    ? `${bytes} B`
    : `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
}
