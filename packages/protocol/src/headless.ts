import { z } from 'zod';

import { nonEmptyIdSchema } from './common.js';
import { runtimeBootstrapSchema, runtimeErrorSchema } from './host.js';
import {
  runtimeCommandSchema,
  runtimeEventEnvelopeSchema,
  runtimeResultSchema,
  runtimeStatusSchema
} from './public.js';

export const headlessHelloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.literal('2.0'),
  bootstrap: runtimeBootstrapSchema,
  resumeCursor: z.number().int().nonnegative().default(0)
}).strict();

export const headlessInputSchema = z.discriminatedUnion('type', [
  headlessHelloSchema,
  z.object({
    type: z.literal('command'),
    requestId: nonEmptyIdSchema,
    command: runtimeCommandSchema
  }).strict(),
  z.object({
    type: z.literal('shutdown'),
    requestId: nonEmptyIdSchema
  }).strict()
]);
export type HeadlessInput = z.infer<typeof headlessInputSchema>;

export const headlessOutputSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    protocolVersion: z.literal('2.0'),
    status: runtimeStatusSchema,
    resumeCursor: z.number().int().nonnegative()
  }).strict(),
  z.object({
    type: z.literal('response'),
    requestId: nonEmptyIdSchema,
    outcome: z.discriminatedUnion('ok', [
      z.object({ ok: z.literal(true), result: runtimeResultSchema }).strict(),
      z.object({ ok: z.literal(false), error: runtimeErrorSchema }).strict()
    ])
  }).strict(),
  z.object({
    type: z.literal('event'),
    event: runtimeEventEnvelopeSchema
  }).strict(),
  z.object({
    type: z.literal('fatal'),
    code: z.string().regex(/^[a-z][a-z0-9_]{1,127}$/),
    message: z.string().min(1).max(4_096),
    retryable: z.literal(false)
  }).strict()
]);
export type HeadlessOutput = z.infer<typeof headlessOutputSchema>;

export function parseHeadlessInput(input: unknown): HeadlessInput {
  return headlessInputSchema.parse(input);
}

export function parseHeadlessOutput(input: unknown): HeadlessOutput {
  return headlessOutputSchema.parse(input);
}
