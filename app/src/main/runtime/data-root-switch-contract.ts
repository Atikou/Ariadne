import { isAbsolute } from 'node:path';
import { z } from 'zod';
export const dataRootSwitchPrepareSchema = z.object({ protocol: z.literal('ariadne_data_root_switch.v1'), type: z.literal('prepare'),
  operationId: z.uuid(), dataRoot: z.string().max(4096).refine(isAbsolute), choice: z.enum(['original', 'replacement']),
  relaunch: z.object({ executable: z.string().max(4096).refine(isAbsolute), appPath: z.string().max(4096).refine(isAbsolute),
    packaged: z.boolean() }).strict().optional() }).strict();
export const dataRootSwitchArmSchema = z.object({ protocol: z.literal('ariadne_data_root_switch.v1'), type: z.literal('arm'), operationId: z.uuid() }).strict();
export const dataRootSwitchResponseSchema = z.object({ protocol: z.literal('ariadne_data_root_switch.v1'),
  type: z.enum(['ready', 'armed']), operationId: z.uuid() }).strict();
