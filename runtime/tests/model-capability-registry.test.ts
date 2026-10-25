import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deriveModelCapabilities,
  unknownQualification
} from '../src/model/capability/ModelCapabilityQualification.js';
import {
  ModelCapabilityRegistry
} from '../src/model/capability/ModelCapabilityRegistry.js';
import { LocalTextCapabilityProbe } from '../src/model/capability/LocalTextCapabilityProbe.js';
import type { ModelClient } from '../src/model/types.js';
import { initializeModelCapabilitySchema } from '../src/model/capability/ModelCapabilityDbSchema.js';
import { readOwnedAuthorityFault } from '../src/adapters/persistence/SqliteAuthorityHealth.js';

const roots: string[] = [];
const FINGERPRINT_A = `sha256:${'a'.repeat(64)}`;
const FINGERPRINT_B = `sha256:${'b'.repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ModelCapabilityRegistry', () => {
  it.each([0, 1])('opens the released metadata-1 DDL at user_version %i without changing qualification evidence', version => {
    const databasePath = temporaryDatabase(), db = new DatabaseSync(databasePath);
    const report = { ...unknownQualification({ providerId: 'fixture', modelId: 'model', fingerprint: FINGERPRINT_A }), textResponse: 'qualified' as const };
    // Released DDL, intentionally independent of the current schema initializer.
    db.exec(`CREATE TABLE model_capability_metadata (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL
    );
    CREATE TABLE model_capability_qualification (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      adapter_protocol_version INTEGER NOT NULL,
      report_json TEXT NOT NULL,
      tested_at TEXT,
      PRIMARY KEY (provider_id, model_id, fingerprint)
    );
    INSERT INTO model_capability_metadata VALUES (1, 1);
    PRAGMA user_version=${version};`);
    db.prepare('INSERT INTO model_capability_qualification VALUES (?,?,?,?,?,?)').run('fixture', 'model', FINGERPRINT_A, 1, JSON.stringify(report), null);
    const originalSchema = db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
    db.close();
    const registry = new ModelCapabilityRegistry(databasePath);
    try { registry.registerFingerprint('fixture', 'model', FINGERPRINT_A); expect(registry.current('fixture', 'model')).toEqual(report); }
    finally { registry.close(); }
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(reopened.prepare('SELECT sql FROM sqlite_master ORDER BY name').all()).toEqual(originalSchema);
      expect(reopened.prepare('SELECT report_json FROM model_capability_qualification').get()!.report_json).toBe(JSON.stringify(report));
    } finally { reopened.close(); }
  });

  it.each(['constraint', 'column-type', 'trigger', 'index'])('still rejects altered %s in model authority structure', alteration => {
    const databasePath = temporaryDatabase(), db = new DatabaseSync(databasePath);
    initializeModelCapabilitySchema(db);
    if (alteration === 'constraint' || alteration === 'column-type') {
      db.exec(`DROP TABLE model_capability_metadata;
        CREATE TABLE model_capability_metadata (singleton INTEGER PRIMARY KEY ${alteration === 'constraint' ? '' : 'CHECK(singleton=1)'},
          schema_version ${alteration === 'column-type' ? 'TEXT' : 'INTEGER'} NOT NULL);
        INSERT INTO model_capability_metadata VALUES(1,1);`);
    } else if (alteration === 'trigger') db.exec('CREATE TRIGGER unwanted AFTER DELETE ON model_capability_qualification BEGIN DELETE FROM model_capability_metadata; END;');
    else db.exec('CREATE INDEX unwanted ON model_capability_qualification(model_id);');
    db.close();
    const before = readFileSync(databasePath);
    expect(() => new ModelCapabilityRegistry(databasePath)).toThrow();
    expect(readFileSync(databasePath)).toEqual(before);
  });

  it('audits malformed rows before promoting metadata-1 stores and preserves their original bytes', () => {
    const databasePath=temporaryDatabase(), db=new DatabaseSync(databasePath);
    try { initializeModelCapabilitySchema(db); db.prepare('INSERT INTO model_capability_qualification VALUES (?,?,?,?,?,?)')
      .run('fixture','model',FINGERPRINT_A,1,'{"private":"invalid source"}',null); db.exec('PRAGMA user_version=0;'); }
    finally {db.close();}
    const before=readFileSync(databasePath); let caught:unknown;
    try {new ModelCapabilityRegistry(databasePath);} catch(error) {caught=error;}
    expect(readOwnedAuthorityFault(caught)).toEqual({source:'inference',kind:'integrity'});
    expect(readFileSync(databasePath)).toEqual(before);
  });
  it('fences an opened corrupted registry rather than overwriting it with a later qualification', () => {
    const databasePath=temporaryDatabase(), registry=new ModelCapabilityRegistry(databasePath);
    const report=unknownQualification({providerId:'fixture',modelId:'model',fingerprint:FINGERPRINT_A});
    try {
      registry.write(report); const external=new DatabaseSync(databasePath);
      try {external.prepare('UPDATE model_capability_qualification SET report_json=?').run('{private invalid JSON');} finally {external.close();}
      expect(()=>registry.read('fixture','model',FINGERPRINT_A)).toThrow('inference_persisted_record_invalid');
      expect(()=>registry.assertHealthy()).toThrow('inference_authority_integrity');
      expect(()=>registry.write(report)).toThrow('inference_authority_integrity');
      expect(()=>registry.registerFingerprint('fixture','other',FINGERPRINT_B)).toThrow('inference_authority_integrity');
    } finally {registry.close();}
    const read=new DatabaseSync(databasePath,{readOnly:true});
    try {expect(read.prepare('SELECT report_json FROM model_capability_qualification').get()!.report_json).toBe('{private invalid JSON');}
    finally {read.close();}
  });
  it('rejects future metadata and future user_version before changing the business database', () => {
    for (const future of ['metadata','user-version'] as const) {
      const databasePath = temporaryDatabase(); const db = new DatabaseSync(databasePath);
      try {
        initializeModelCapabilitySchema(db);
        db.prepare('INSERT INTO model_capability_qualification VALUES (?,?,?,?,?,?)').run('fixture','model',FINGERPRINT_A,1,'PRESERVE_FUTURE_CACHE',null);
        if (future === 'metadata') db.exec('PRAGMA user_version=0; UPDATE model_capability_metadata SET schema_version=2;');
        else db.exec('PRAGMA user_version=2;');
      } finally {db.close();}
      const bytes = readFileSync(databasePath);
      for (let repeat=0;repeat<2;repeat++) expect(()=>new ModelCapabilityRegistry(databasePath)).toThrow(
        future==='metadata'?'model_capability_metadata_schema_unsupported':'model_capability_schema_unsupported:2');
      expect(readFileSync(databasePath).equals(bytes)).toBe(true);
    }
  });
  it('refuses unmanaged databases rather than creating metadata around unrelated data', () => {
    const databasePath=temporaryDatabase();const db=new DatabaseSync(databasePath);
    try {db.exec("CREATE TABLE alien_data(value TEXT); INSERT INTO alien_data VALUES('KEEP');");}finally{db.close();}
    const hash=()=>createHash('sha256').update(readFileSync(databasePath)).digest('hex');const before=hash();
    expect(()=>new ModelCapabilityRegistry(databasePath)).toThrow('model_capability_database_unmanaged');expect(hash()).toBe(before);
  });
  it('recognizes the existing metadata-1 cache and preserves its exact reports while establishing user_version', () => {
    const databasePath=temporaryDatabase();const db=new DatabaseSync(databasePath);
    const report={...unknownQualification({providerId:'fixture',modelId:'model',fingerprint:FINGERPRINT_A}),textResponse:'qualified' as const};
    try {initializeModelCapabilitySchema(db);db.prepare('INSERT INTO model_capability_qualification VALUES (?,?,?,?,?,?)')
      .run('fixture','model',FINGERPRINT_A,1,JSON.stringify(report),null);db.exec('PRAGMA user_version=0;');}finally{db.close();}
    const registry=new ModelCapabilityRegistry(databasePath);
    try {registry.registerFingerprint('fixture','model',FINGERPRINT_A);expect(registry.current('fixture','model')).toEqual(report);}
    finally{registry.close();}
    const reopened=new DatabaseSync(databasePath,{readOnly:true});try{expect(reopened.prepare('PRAGMA user_version').get()!.user_version).toBe(1);
      expect(reopened.prepare('SELECT report_json FROM model_capability_qualification').get()!.report_json).toBe(JSON.stringify(report));}
    finally{reopened.close();}
  });
  it('fences a second owner and releases the lease only after close', () => {
    const databasePath=temporaryDatabase();const registry=new ModelCapabilityRegistry(databasePath);
    try {expect(()=>new ModelCapabilityRegistry(databasePath)).toThrow('sqlite_owner_lease_unavailable:model-capability');}
    finally{registry.close();}
    const reopened=new ModelCapabilityRegistry(databasePath);reopened.close();
  });
  it('rejects a valid report stored under another exact identity', () => {
    const databasePath=temporaryDatabase();const db=new DatabaseSync(databasePath);
    try {initializeModelCapabilitySchema(db);db.prepare('INSERT INTO model_capability_qualification VALUES (?,?,?,?,?,?)')
      .run('fixture','model',FINGERPRINT_A,1,JSON.stringify(unknownQualification({providerId:'other',modelId:'model',fingerprint:FINGERPRINT_A})),null);}
    finally{db.close();}
    const before=readFileSync(databasePath);
    expect(()=>new ModelCapabilityRegistry(databasePath)).toThrow('stored_identity_mismatch');
    expect(readFileSync(databasePath)).toEqual(before);
  });
  it('persists exact-fingerprint qualification and invalidates it on fingerprint change', () => {
    const databasePath = temporaryDatabase();
    const first = new ModelCapabilityRegistry(databasePath);
    first.registerFingerprint('ariadne.local', 'qwen', FINGERPRINT_A);
    first.write({
      ...unknownQualification({
        providerId: 'ariadne.local',
        modelId: 'qwen',
        fingerprint: FINGERPRINT_A
      }),
      textResponse: 'qualified',
      testedAt: '2032-01-01T00:00:00.000Z'
    });
    expect(deriveModelCapabilities(first.current('ariadne.local', 'qwen')!))
      .toMatchObject({ supportsTextChat: true, supportsAgent: false, supportsPlan: false });
    first.close();

    const reopened = new ModelCapabilityRegistry(databasePath);
    reopened.registerFingerprint('ariadne.local', 'qwen', FINGERPRINT_A);
    expect(reopened.current('ariadne.local', 'qwen')?.textResponse).toBe('qualified');
    reopened.registerFingerprint('ariadne.local', 'qwen', FINGERPRINT_B);
    expect(reopened.current('ariadne.local', 'qwen')?.textResponse).toBe('unknown');
    reopened.close();
  });

  it('qualifies non-empty plain text without granting Agent or Plan', async () => {
    const registry = new ModelCapabilityRegistry(temporaryDatabase());
    const chat = vi.fn(async (request: Parameters<ModelClient['chat']>[0]) => {
      request.onToken?.('一加一等于二。');
      return {
        content: '一加一等于二。',
        toolCalls: [],
        clientName: 'qwen',
        modelName: 'Qwen',
        location: 'local' as const,
        latencyMs: 1
      };
    });
    const probe = new LocalTextCapabilityProbe(registry);
    const report = await probe.run({
      providerId: 'ariadne.local',
      modelId: 'qwen',
      fingerprint: FINGERPRINT_A,
      client: modelClient(chat)
    });

    expect(chat).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      textResponse: 'qualified',
      streamingText: 'qualified',
      exactTokenizer: 'qualified',
      nativeToolCalls: 'rejected'
    });
    expect(deriveModelCapabilities(report)).toEqual({
      supportsTextChat: true,
      supportsAgent: false,
      supportsPlan: false,
      supportsVision: false,
      qualificationState: 'qualified'
    });
    registry.close();
  });

  it('rejects an empty response instead of interpreting it or granting a capability', async () => {
    const registry = new ModelCapabilityRegistry(temporaryDatabase());
    const probe = new LocalTextCapabilityProbe(registry);
    const report = await probe.run({
      providerId: 'ariadne.local',
      modelId: 'empty',
      fingerprint: FINGERPRINT_A,
      client: modelClient(async () => ({
        content: '   ',
        toolCalls: [],
        clientName: 'empty',
        modelName: 'Empty',
        location: 'local',
        latencyMs: 1
      }))
    });

    expect(report.textResponse).toBe('rejected');
    expect(report.failureCode).toBe('model_response_empty');
    expect(deriveModelCapabilities(report).supportsTextChat).toBe(false);
    registry.close();
  });
});

function modelClient(chat: ModelClient['chat']): ModelClient {
  return {
    name: 'qwen',
    model: 'Qwen',
    location: 'local',
    toolCallCapability: 'unsupported',
    contextWindowTokens: 32_768,
    isAvailable: async () => true,
    chat,
    tokenCounter: {
      profile: 'test',
      exact: true,
      countText: async () => ({
        tokens: 1,
        exact: true,
        method: 'model_tokenizer',
        tokenizer: 'test'
      }),
      countMessages: async () => ({
        tokens: 1,
        exact: true,
        method: 'model_tokenizer',
        tokenizer: 'test'
      }),
      countTools: async () => ({
        tokens: 0,
        exact: true,
        method: 'model_tokenizer',
        tokenizer: 'test'
      }),
      countRequest: async () => ({
        tokens: 1,
        exact: true,
        method: 'model_tokenizer',
        tokenizer: 'test'
      })
    }
  };
}

function temporaryDatabase(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-model-capability-'));
  roots.push(root);
  return path.join(root, 'model-capability.db');
}
