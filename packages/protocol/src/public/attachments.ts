import { z } from 'zod';

export const IMAGE_ATTACHMENT_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp'
] as const;

export const MAX_IMAGE_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_IMAGE_ATTACHMENT_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_ATTACHMENT_DIMENSION = 8_192;
export const MAX_IMAGE_ATTACHMENT_PIXELS = 64_000_000;

export const imageAttachmentMediaTypeSchema = z.enum(
  IMAGE_ATTACHMENT_MEDIA_TYPES
);

const imageDimensionsSchema = z.object({
  width: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_DIMENSION),
  height: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_DIMENSION)
}).strict().refine(
  ({ width, height }) => width * height <= MAX_IMAGE_ATTACHMENT_PIXELS,
  'Image attachment dimensions exceed the pixel limit.'
);

/** Durable provider-neutral reference. It is never a path, URL, or bearer token. */
export const imageAttachmentRefSchema = z.object({
  attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  mediaType: imageAttachmentMediaTypeSchema,
  bytes: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_SOURCE_BYTES),
  width: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_DIMENSION),
  height: z.number().int().positive().max(MAX_IMAGE_ATTACHMENT_DIMENSION),
  name: z.string().trim().min(1).max(256).optional(),
  originalDimensions: imageDimensionsSchema.optional()
}).strict().refine(
  ({ width, height }) => width * height <= MAX_IMAGE_ATTACHMENT_PIXELS,
  'Image attachment dimensions exceed the pixel limit.'
);
export type ImageAttachmentRef = z.infer<typeof imageAttachmentRefSchema>;

/** Wire-only image upload. The bytes are committed before a Message is published. */
export const encodedImageAttachmentSchema = z.object({
  mediaType: imageAttachmentMediaTypeSchema,
  data: z.string()
    .min(4)
    .max(Math.ceil(MAX_IMAGE_ATTACHMENT_SOURCE_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  name: z.string().trim().min(1).max(256).optional()
}).strict().superRefine((value, context) => {
  if (decodedBase64Bytes(value.data) > MAX_IMAGE_ATTACHMENT_SOURCE_BYTES) {
    context.addIssue({
      code: 'custom',
      path: ['data'],
      message: 'Encoded image attachment exceeds the source byte limit.'
    });
  }
});
export type EncodedImageAttachment = z.infer<typeof encodedImageAttachmentSchema>;

export const encodedImageAttachmentsSchema = z.array(encodedImageAttachmentSchema)
  .min(1)
  .max(MAX_IMAGE_ATTACHMENTS_PER_MESSAGE)
  .superRefine((attachments, context) => {
    const bytes = attachments.reduce(
      (total, attachment) => total + decodedBase64Bytes(attachment.data),
      0
    );
    if (bytes > MAX_IMAGE_ATTACHMENT_MESSAGE_BYTES) {
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
