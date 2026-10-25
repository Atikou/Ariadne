import { z } from 'zod';
import { runtimeInstanceIdSchema } from '../common.js';

export const agentPersistenceKeyIdSchema = z.string().regex(
  /^agent-key-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
);
const agentPersistenceKeyMaterialSchema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/u);
export const agentPersistenceKeyRingSchema = z.object({
  schemaVersion: z.literal(1), runtimeInstanceId: runtimeInstanceIdSchema,
  generation: z.number().int().positive().safe(), activeKeyId: agentPersistenceKeyIdSchema,
  keys: z.array(z.object({ keyId: agentPersistenceKeyIdSchema, keyMaterialBase64: agentPersistenceKeyMaterialSchema }).strict()).min(1).max(32)
}).strict().superRefine((ring, context) => {
  const keyIds = new Set<string>(), keyMaterials = new Set<string>();
  for (const [index, key] of ring.keys.entries()) {
    if (keyIds.has(key.keyId)) context.addIssue({ code: 'custom', path: ['keys', index, 'keyId'], message: 'Agent persistence key ids must be unique.' });
    if (keyMaterials.has(key.keyMaterialBase64)) context.addIssue({ code: 'custom', path: ['keys', index, 'keyMaterialBase64'], message: 'Agent persistence key material must be unique.' });
    keyIds.add(key.keyId); keyMaterials.add(key.keyMaterialBase64);
  }
  if (!keyIds.has(ring.activeKeyId)) context.addIssue({ code: 'custom', path: ['activeKeyId'], message: 'The active Agent persistence key must be present.' });
});
