import { z } from 'zod';
import { isCanonicalAbsoluteDataRoot, storageMaintenanceResponseSchema } from '@ariadne/protocol/host';
const root = z.string().min(1).max(32_768).refine(isCanonicalAbsoluteDataRoot);
export const electronBackupValidationRequestSchema = z.object({
  protocol: z.literal('ariadne_electron_backup_validation.v1'), requestId: z.uuid(), restoreRoot: root,
  runtimeEntry: root, runtimeExecutable: root
}).strict();
export const recoveryValidationPhaseSchema = z.enum(['request', 'profile', 'main-files', 'runtime-files', 'profile-retained',
  'runtime-layout', 'runtime-key-anchor', 'runtime-agent-payloads', 'runtime-conversation']);
export const electronBackupValidationResponseSchema = z.object({
  protocol: z.literal('ariadne_electron_backup_validation.v1'), requestId: z.uuid(),
  outcome: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), checkedPrivateFiles: z.number().int().nonnegative().max(10),
      runtime: storageMaintenanceResponseSchema.shape.outcome.options[0].shape.result }).strict(),
    z.object({ ok: z.literal(false), code: z.literal('isolated_recovery_validation_failed'), phase: recoveryValidationPhaseSchema }).strict()
  ])
}).strict();
export type ElectronBackupValidationRequest = z.infer<typeof electronBackupValidationRequestSchema>;
export type ElectronBackupValidationResponse = z.infer<typeof electronBackupValidationResponseSchema>;
