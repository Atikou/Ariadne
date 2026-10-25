import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { DATABASE_PATHS } from '../src/adapters/persistence/DatabasePaths.js';
import { openAgentControlDatabase } from '../src/adapters/persistence/agentControlDbSchema.js';
import { openConversationDatabase } from '../src/adapters/persistence/ConversationDbSchema.js';
import { openPublicProjectionDatabase } from '../src/adapters/persistence/PublicProjectionDbSchema.js';
import { closeOwnedSqliteDatabase } from '../src/adapters/persistence/SqliteOwnerLease.js';
import { migrateRuntimeCommandDatabase } from '../src/adapters/persistence/runtimeCommandDbMigrations.js';
import { initializeProductivitySchemaV2 } from '../src/adapters/persistence/ProductivityDbSchema.js';
import { initializeLongMemorySchema } from '../src/adapters/persistence/LongMemoryDbSchema.js';
import { initializeModelCapabilitySchema } from '../src/model/capability/ModelCapabilityDbSchema.js';

const manifest = JSON.parse(readFileSync(new URL('../config/database-layout.json', import.meta.url), 'utf8')) as {
  contractVersion: number; owners: { owner: string; relativePath: string; schemaMetadataVersion: number; schemaDigest: string; tables: string[] }[];
};
const initializers = { runtimeCommand: migrateRuntimeCommandDatabase, productivity: initializeProductivitySchemaV2,
  longMemory: initializeLongMemorySchema, modelCapability: initializeModelCapabilitySchema };
const openers = { agentControl: openAgentControlDatabase, conversation: openConversationDatabase, publicProjection: openPublicProjectionDatabase };

describe('fixed database layout contract', () => {
  it('declares every owner once and gives all owners an unnumbered fixed path', () => {
    expect(manifest.contractVersion).toBe(1);
    expect(manifest.owners.map(owner => owner.owner).sort()).toEqual(Object.keys(DATABASE_PATHS).sort());
    for (const entry of manifest.owners) {
      expect(entry.relativePath).toBe(DATABASE_PATHS[entry.owner as keyof typeof DATABASE_PATHS]);
      expect(entry.relativePath).not.toMatch(/(?:^|[_/-])v\d/iu);
    }
  });
  it.each(manifest.owners)('preserves the frozen $owner tables, constraints, indexes and schema metadata', entry => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-layout-contract-'));
    const opener = openers[entry.owner as keyof typeof openers];
    const opened = opener ? opener(root) : { database: new DatabaseSync(':memory:') };
    try {
      if (!opener) initializers[entry.owner as keyof typeof initializers](opened.database);
      if ('databasePath' in opened) expect(path.relative(root, opened.databasePath).replaceAll('\\', '/')).toBe(entry.relativePath);
      const schema = opened.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
        .map(row => ({ ...row, sql: typeof row.sql === 'string' ? row.sql.replace(/\s+/gu, ' ').trim() : null }));
      expect(schema.map(row => row.name).every(name => !/(?:^|[_-])v\d/iu.test(String(name)))).toBe(true);
      expect(schema.filter(row => row.type === 'table').map(row => row.name)).toEqual(entry.tables);
      expect(`sha256:${createHash('sha256').update(JSON.stringify(schema)).digest('hex')}`).toBe(entry.schemaDigest);
      expect(Number(opened.database.prepare('PRAGMA user_version').get()!.user_version)).toBe(entry.schemaMetadataVersion);
    } finally {
      if ('ownerLease' in opened) closeOwnedSqliteDatabase(opened.database, opened.ownerLease);
      else opened.database.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
