import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MEMORY_CONTROL_SHADOW_TABLES, preflightMemoryControlShadows,
  RETIRED_CONTROL_DATA_UNSUPPORTED } from '../src/adapters/persistence/memoryControlShadowRetirement.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const value = mkdtempSync(path.join(os.tmpdir(), 'ariadne-retired-detection-')); roots.push(value); return value; };
describe('read-only unsupported retired control format recognition', () => {
  it('does not create a database or directory for an absent retired file', () => {
    const dataRoot = root(); const before = readdirSync(dataRoot);
    expect(preflightMemoryControlShadows(dataRoot).presentTables).toEqual([]);
    expect(readdirSync(dataRoot)).toEqual(before); expect(existsSync(path.join(dataRoot, 'data'))).toBe(false);
  });
  it.each(MEMORY_CONTROL_SHADOW_TABLES)('rejects populated %s without changing any original bytes', table => {
    const dataRoot = root(); const directory = path.join(dataRoot, 'data/agent_data'); mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'memory.db'); const database = new DatabaseSync(file);
    database.exec(`CREATE TABLE ${table} (sentinel TEXT); INSERT INTO ${table} VALUES ('preserve');`); database.close();
    const before = readFileSync(file); const entries = readdirSync(directory);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(() => preflightMemoryControlShadows(dataRoot)).toThrow(`${RETIRED_CONTROL_DATA_UNSUPPORTED}:${table}`);
      expect(readFileSync(file)).toEqual(before); expect(readdirSync(directory)).toEqual(entries);
    }
  });
  it('leaves empty scaffolding intact without applying a migration', () => {
    const dataRoot = root(); const directory = path.join(dataRoot, 'data/agent_data'); mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'memory.db'); const database = new DatabaseSync(file);
    database.exec('CREATE TABLE agent_v2_runs (sentinel TEXT); PRAGMA user_version=43;'); database.close();
    const before = readFileSync(file);
    expect(preflightMemoryControlShadows(dataRoot).presentTables).toEqual(['agent_v2_runs']);
    expect(readFileSync(file)).toEqual(before);
  });
});
