import { z } from 'zod';

export const ARIADNE_RUNTIME_PROTOCOL = 'ariadne_runtime' as const;
export const ARIADNE_RUNTIME_PROTOCOL_VERSION = '2.0' as const;
// Public Runtime payloads may contain a persisted Companion message of up to
// 2,000,000 characters. Reserve enough UTF-8 envelope space for that contract
// while retaining a hard IPC memory ceiling.
export const MAX_RUNTIME_MESSAGE_BYTES = 8 * 1024 * 1024;

export const nonEmptyIdSchema = z.string().trim().min(1).max(256);
export const runtimeInstanceIdSchema = z.string().uuid();
export const isoDateTimeSchema = z.string().datetime({ offset: true });

export const jsonPrimitiveSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null()
]);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)])
);

export const resourceReferenceSchema = z
  .object({
    resourceId: nonEmptyIdSchema,
    name: z.string().trim().min(1).max(512),
    mediaType: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().nonnegative().max(2 * 1024 * 1024 * 1024),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    lifecycle: z.enum(['temporary', 'session', 'run', 'persistent']),
    sensitivity: z.enum(['public', 'workspace', 'sensitive', 'secret']),
    provenance: z.object({
      origin: z.string().trim().min(1).max(128),
      sourceId: nonEmptyIdSchema.optional(),
      summary: z.string().trim().min(1).max(1_024).optional()
    }).strict()
  })
  .strict();

export type ResourceReference = z.infer<typeof resourceReferenceSchema>;

export function assertRuntimeMessageSize(
  value: unknown,
  maxBytes = MAX_RUNTIME_MESSAGE_BYTES
): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) {
    throw new Error(`runtime_message_too_large:${bytes}:${maxBytes}`);
  }
}
