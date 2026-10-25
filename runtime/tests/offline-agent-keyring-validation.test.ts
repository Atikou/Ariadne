import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createAgentControlDatabaseSchema } from '../src/adapters/persistence/agentControlDbSchema.js';
import { verifyKeyringAnchorReadOnly, verifyOrInitializeKeyringAnchor } from '../src/adapters/persistence/AgentControlKeyring.js';

const request = { generation: 1, activeKeyId: 'fixture-key', availableKeyIds: ['fixture-key'], requiredCodecId: 'aes-256-gcm-v1' };
describe('original Agent recovery key anchor in readonly maintenance', () => {
  it('accepts a genuinely empty current store without installing metadata or changing the source', () => {
    const database = new DatabaseSync(':memory:');
    try {
      createAgentControlDatabaseSchema(database); database.exec('PRAGMA query_only=ON');
      expect(() => verifyKeyringAnchorReadOnly(database, request)).not.toThrow();
      expect(database.prepare('SELECT * FROM agent_control_metadata').all()).toEqual([]);
    } finally { database.close(); }
  });

  it('uses the original anchor checks and rejects mismatched or uncommitted restored key generations', async () => {
    const database = new DatabaseSync(':memory:');
    try {
      createAgentControlDatabaseSchema(database);
      await verifyOrInitializeKeyringAnchor(database, request, { now: () => new Date('2026-10-06T00:00:00Z') });
      const before = database.prepare('SELECT * FROM agent_control_metadata ORDER BY key').all(); database.exec('PRAGMA query_only=ON');
      expect(() => verifyKeyringAnchorReadOnly(database, request)).not.toThrow();
      expect(() => verifyKeyringAnchorReadOnly(database, { ...request, generation: 2 })).toThrow('agent_keyring_anchor_rotation_not_committed');
      expect(() => verifyKeyringAnchorReadOnly(database, { ...request, activeKeyId: 'other-key', availableKeyIds: ['other-key'] }))
        .toThrow('agent_keyring_anchor_active_key_mismatch');
      expect(database.prepare('SELECT * FROM agent_control_metadata ORDER BY key').all()).toEqual(before);
    } finally { database.close(); }
  });
});
