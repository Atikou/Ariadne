import { z } from 'zod';

export const IMAGE_ATTACHMENT_MEDIA_TYPES_V3 = [
  'image/png',
  'image/jpeg',
  'image/webp'
] as const;

export const MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3 = 4;
export const MAX_IMAGE_ATTACHMENT_SOURCE_BYTES_V3 = 2 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES_V3 = 2 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_DIMENSION_V3 = 8_192;
export const MAX_IMAGE_ATTACHMENT_PIXELS_V3 = 64_000_000;

export const imageAttachmentMediaTypeV3Schema = z.enum(
  IMAGE_ATTACHMENT_MEDIA_TYPES_V3
);

const imageDimensionsV3Schema = z.object({
  width: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_DIMENSION_V3),
  height: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_DIMENSION_V3)
}).strict().refine(
  ({ width, height }) => width * height <= MAX_IMAGE_ATTACHMENT_PIXELS_V3,
  'Image attachment dimensions exceed the pixel limit.'
);

/** Durable provider-neutral reference. It is never a path, URL, or bearer token. */
export const imageAttachmentRefV3Schema = z.object({
  attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  mediaType: imageAttachmentMediaTypeV3Schema,
  bytes: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_SOURCE_BYTES_V3),
  width: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_DIMENSION_V3),
  height: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_DIMENSION_V3),
  name: z.string().trim().min(1).max(256).optional(),
  originalDimensions: imageDimensionsV3Schema.optional()
}).strict().refine(
  ({ width, height }) => width * height <= MAX_IMAGE_ATTACHMENT_PIXELS_V3,
  'Image attachment dimensions exceed the pixel limit.'
);
export type ImageAttachmentRefV3 = z.infer<typeof imageAttachmentRefV3Schema>;

/** Wire-only image upload. The bytes are committed before a Message is published. */
export const encodedImageAttachmentV3Schema = z.object({
  mediaType: imageAttachmentMediaTypeV3Schema,
  data: z.string()
    .min(4)
    .max(Math.ceil(MAX_IMAGE_ATTACHMENT_SOURCE_BYTES_V3 / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  name: z.string().trim().min(1).max(256).optional()
}).strict().superRefine((value, context) => {
  if (decodedBase64Bytes(value.data) > MAX_IMAGE_ATTACHMENT_SOURCE_BYTES_V3) {
    context.addIssue({
      code: 'custom',
      path: ['data'],
      message: 'Encoded image attachment exceeds the source byte limit.'
    });
  }
});
export type EncodedImageAttachmentV3 = z.infer<typeof encodedImageAttachmentV3Schema>;

export const encodedImageAttachmentsV3Schema = z.array(encodedImageAttachmentV3Schema)
  .min(1)
  .max(MAX_IMAGE_ATTACHMENTS_PER_MESSAGE_V3)
  .superRefine((attachments, context) => {
    const bytes = attachments.reduce(
      (total, attachment) => total + decodedBase64Bytes(attachment.data),
      0
    );
    if (bytes > MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES_V3) {
      context.addIssue({
        code: 'custom',
        message: 'Encoded image attachments exceed the message byte limit.'
      });
    }
  });

function decodedBase64Bytes(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding;
}
