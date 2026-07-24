import path from "node:path";

import { z } from "zod";

const nativeAbsolutePath = z
  .string()
  .trim()
  .min(1)
  .max(32_768)
  .refine(
    (value) => path.win32.isAbsolute(value) || path.posix.isAbsolute(value),
    "必须为绝对目录路径",
  );

export const SelectDirectoryRequestSchema = z
  .object({
    initialDirectory: nativeAbsolutePath.optional(),
  })
  .strict();

export const SelectDirectorySelectedResultSchema = z
  .object({
    available: z.literal(true),
    cancelled: z.literal(false),
    path: nativeAbsolutePath,
  })
  .strict();

export const SelectDirectoryCancelledResultSchema = z
  .object({
    available: z.literal(true),
    cancelled: z.literal(true),
  })
  .strict();

export const SelectDirectoryResultSchema = z.discriminatedUnion("cancelled", [
  SelectDirectorySelectedResultSchema,
  SelectDirectoryCancelledResultSchema,
]);

export const SelectDirectoryInvalidRequestResultSchema = operationError("invalid_request");
export const SelectDirectoryBusyResultSchema = operationError("directory_picker_busy");
export const SelectDirectoryFailedResultSchema = operationError("directory_picker_failed");
export const SelectDirectoryUnavailableResultSchema = operationError("unsupported_platform");

function operationError<TCode extends string>(code: TCode) {
  return z
    .object({
      error: z.string().min(1).max(4_096),
      code: z.literal(code),
    })
    .strict();
}

export type SelectDirectoryRequest = z.infer<typeof SelectDirectoryRequestSchema>;
export type SelectDirectoryResult = z.infer<typeof SelectDirectoryResultSchema>;
