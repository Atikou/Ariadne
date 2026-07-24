import type { DatabaseSync } from "node:sqlite";

import {
  CompanionPersonaSchema,
  CompanionPersonaVersionSchema,
  type CompanionPersona,
  type CompanionPersonaVersion,
} from "./CompanionPersonaContracts.js";
import { DEFAULT_PERSONA } from "./PersonaRuntime.js";

type PersonaRow = {
  id: string;
  name: string;
  system_prompt: string;
  description: string | null;
  readonly: number;
  active: number;
  version: number;
  created_at: string;
  updated_at: string;
};

type PersonaVersionRow = {
  id: string;
  persona_id: string;
  version: number;
  name: string;
  system_prompt: string;
  description: string | null;
  created_at: string;
};

/** Owns the persona aggregate while the parent CompanionStorage owns the SQLite connection. */
export class CompanionPersonaRepository {
  constructor(private readonly db: DatabaseSync) {}

  assertDefaultInvariant(): void {
    const current = this.get(DEFAULT_PERSONA.id);
    if (!current || !current.readonly || !current.active) {
      throw new Error("companion_default_persona_invariant_missing");
    }
  }

  list(options?: { includeInactive?: boolean }): CompanionPersona[] {
    const rows = this.db
      .prepare(
        options?.includeInactive
          ? `SELECT * FROM companion_personas ORDER BY readonly DESC, updated_at DESC`
          : `SELECT * FROM companion_personas WHERE active=1 ORDER BY readonly DESC, updated_at DESC`,
      )
      .all() as PersonaRow[];
    return rows.map(mapPersona);
  }

  get(id: string): CompanionPersona | null {
    const row = this.db
      .prepare(`SELECT * FROM companion_personas WHERE id=?`)
      .get(id) as PersonaRow | undefined;
    return row ? mapPersona(row) : null;
  }

  create(input: {
    id?: string;
    name: string;
    systemPrompt: string;
    description?: string;
  }): CompanionPersona {
    const id = input.id ?? crypto.randomUUID();
    if (id === DEFAULT_PERSONA.id) throw new Error("默认 persona id 不能用于创建自定义人格");
    const name = input.name.trim();
    const systemPrompt = input.systemPrompt.trim();
    if (!name) throw new Error("人格名称不能为空");
    if (!systemPrompt) throw new Error("人格系统提示不能为空");
    const at = nowIso();
    return this.inTransaction(() => {
      this.assertActiveNameAvailable(name);
      this.db
        .prepare(
          `INSERT INTO companion_personas
            (id, name, system_prompt, description, readonly, active, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 1, 1, ?, ?)`,
        )
        .run(id, name, systemPrompt, input.description ?? null, at, at);
      this.insertVersion(id, 1, name, systemPrompt, input.description, at);
      return this.get(id)!;
    });
  }

  update(
    id: string,
    patch: { name?: string; systemPrompt?: string; description?: string; active?: boolean },
  ): CompanionPersona | null {
    if (
      patch.name === undefined
      && patch.systemPrompt === undefined
      && patch.description === undefined
      && patch.active === undefined
    ) {
      throw new Error("人格更新至少提供一个变更字段");
    }
    return this.inTransaction(() => {
      const current = this.get(id);
      if (!current) return null;
      if (id === DEFAULT_PERSONA.id || current.readonly) {
        throw new Error("默认 persona 为只读，需复制后编辑");
      }
      const next = {
        name: patch.name?.trim() ?? current.name,
        systemPrompt: patch.systemPrompt?.trim() ?? current.systemPrompt,
        description: patch.description ?? current.description,
        active: patch.active ?? current.active,
      };
      if (!next.name) throw new Error("人格名称不能为空");
      if (!next.systemPrompt) throw new Error("人格系统提示不能为空");
      if (
        next.name === current.name
        && next.systemPrompt === current.systemPrompt
        && next.description === current.description
        && next.active === current.active
      ) {
        return current;
      }
      if (next.active) this.assertActiveNameAvailable(next.name, id);
      const at = nowIso();
      const version = current.version + 1;
      this.db
        .prepare(
          `UPDATE companion_personas
           SET name=?, system_prompt=?, description=?, active=?, version=?, updated_at=?
           WHERE id=?`,
        )
        .run(
          next.name,
          next.systemPrompt,
          next.description ?? null,
          next.active ? 1 : 0,
          version,
          at,
          id,
        );
      this.insertVersion(id, version, next.name, next.systemPrompt, next.description, at);
      return this.get(id);
    });
  }

  delete(id: string): boolean {
    return this.inTransaction(() => {
      const current = this.get(id);
      if (!current) return false;
      if (id === DEFAULT_PERSONA.id || current.readonly) {
        throw new Error("默认 persona 不能删除或停用");
      }
      this.db.prepare(`UPDATE companion_sessions SET persona_id=? WHERE persona_id=?`).run(DEFAULT_PERSONA.id, id);
      return this.db.prepare(`DELETE FROM companion_personas WHERE id=?`).run(id).changes > 0;
    });
  }

  listVersions(personaId: string): CompanionPersonaVersion[] {
    const rows = this.db
      .prepare(`SELECT * FROM companion_persona_versions WHERE persona_id=? ORDER BY version DESC`)
      .all(personaId) as PersonaVersionRow[];
    return rows.map(mapPersonaVersion);
  }

  revert(personaId: string, version: number): CompanionPersona | null {
    const current = this.get(personaId);
    if (!current) return null;
    if (current.readonly) throw new Error("默认 persona 不能回滚");
    const row = this.db
      .prepare(`SELECT * FROM companion_persona_versions WHERE persona_id=? AND version=?`)
      .get(personaId, version) as PersonaVersionRow | undefined;
    if (!row) return null;
    const target = mapPersonaVersion(row);
    return this.update(personaId, {
      name: target.name,
      systemPrompt: target.systemPrompt,
      description: target.description,
      active: true,
    });
  }

  private assertActiveNameAvailable(name: string, excludeId?: string): void {
    const row = this.db
      .prepare(
        `SELECT id FROM companion_personas
         WHERE active=1 AND lower(trim(name))=lower(trim(?))
         LIMIT 1`,
      )
      .get(name) as { id: string } | undefined;
    if (row && row.id !== excludeId) throw new Error(`人格名称已存在：${name}`);
  }

  private insertVersion(
    personaId: string,
    version: number,
    name: string,
    systemPrompt: string,
    description: string | undefined,
    at: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO companion_persona_versions
          (id, persona_id, version, name, system_prompt, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), personaId, version, name, systemPrompt, description ?? null, at);
  }

  private inTransaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the aggregate operation error.
      }
      throw error;
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapPersona(row: PersonaRow): CompanionPersona {
  return CompanionPersonaSchema.parse({
    id: row.id,
    name: row.name,
    systemPrompt: row.system_prompt,
    description: row.description ?? undefined,
    readonly: row.readonly === 1,
    active: row.active === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapPersonaVersion(row: PersonaVersionRow): CompanionPersonaVersion {
  return CompanionPersonaVersionSchema.parse({
    id: row.id,
    personaId: row.persona_id,
    version: row.version,
    name: row.name,
    systemPrompt: row.system_prompt,
    description: row.description ?? undefined,
    createdAt: row.created_at,
  });
}
