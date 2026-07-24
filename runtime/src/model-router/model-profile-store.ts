import type { DatabaseSync } from "node:sqlite";

import type { ModelClientConfig } from "../config/types.js";
import type { MetricsRegistry } from "../model/MetricsRegistry.js";
import {
  buildCapabilityMatrixSnapshot,
  type CapabilityMatrixSnapshot,
} from "./model-capabilities.js";
import type { ModelAvailabilityRecord, ModelAvailabilityRegistry } from "./model-availability.js";
import { ModelRegistry } from "./model-registry.js";
import { buildModelProfiles, validateModelProfiles } from "./model-profiles.js";
import type { ModelProfile } from "./types.js";
import type {
  AgentProtocolQualificationRecord,
  AgentProtocolQualificationStore,
} from "./agent-protocol-qualification.js";

export interface ModelProfileRuntimeHint {
  calls: number;
  errors: number;
  errorRate: number;
  fallbackFromCount: number;
  fallbackToCount: number;
}

export interface ModelProfileStoreSnapshot extends CapabilityMatrixSnapshot {
  generatedAt: string;
  enabledCount: number;
  validationErrors: string[];
  runtimeHintsByModelId: Record<string, ModelProfileRuntimeHint>;
  availability?: ModelAvailabilityRecord[];
  agentProtocolQualifications?: AgentProtocolQualificationRecord[];
}

export interface ModelProfileStoreOptions {
  db?: DatabaseSync;
  metrics?: MetricsRegistry;
  availability?: ModelAvailabilityRegistry;
  agentProtocolQualification?: AgentProtocolQualificationStore;
}

/**
 * V8：ModelProfile 统一存储与快照（配置构建 + 能力矩阵 + 只读运行指标，不改配置）。
 */
export class ModelProfileStore {
  private profiles: ModelProfile[];
  readonly registry: ModelRegistry;

  constructor(profiles: ModelProfile[], private readonly opts: ModelProfileStoreOptions = {}) {
    this.profiles = [...profiles];
    this.registry = new ModelRegistry(this.profiles, {
      availability: opts.availability,
      agentProtocolQualification: opts.agentProtocolQualification,
    });
  }

  static fromClients(
    clients: ModelClientConfig[],
    opts: ModelProfileStoreOptions = {},
  ): ModelProfileStore {
    return new ModelProfileStore(buildModelProfiles(clients), opts);
  }

  listAll(): ModelProfile[] {
    return this.registry.listAll();
  }

  get(id: string): ModelProfile | undefined {
    return this.registry.get(id);
  }

  /** 从配置重建 profile（同一 registry 实例，供已持有引用的路由栈热更新）。 */
  reloadFromClients(clients: ModelClientConfig[]): string[] {
    this.profiles = buildModelProfiles(clients);
    this.registry.replaceAll(this.profiles);
    return validateModelProfiles(this.profiles);
  }

  snapshot(): ModelProfileStoreSnapshot {
    const base = buildCapabilityMatrixSnapshot(this.profiles);
    return {
      ...base,
      generatedAt: new Date().toISOString(),
      enabledCount: this.profiles.filter((p) => p.enabled).length,
      validationErrors: validateModelProfiles(this.profiles),
      runtimeHintsByModelId: this.collectRuntimeHints(),
      availability: this.opts.availability?.snapshot(),
      agentProtocolQualifications: this.opts.agentProtocolQualification?.list(this.profiles),
    };
  }

  private collectRuntimeHints(): Record<string, ModelProfileRuntimeHint> {
    const hints: Record<string, ModelProfileRuntimeHint> = {};
    if (!this.opts.db) return hints;

    const rows = this.opts.db
      .prepare(
        `SELECT model_id,
                COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM model_call_logs
         GROUP BY model_id`,
      )
      .all() as Array<{ model_id: string; calls: number; errors: number }>;

    const fallbackFrom = new Map<string, number>();
    for (const row of this.opts.db
      .prepare(`SELECT from_model_id AS model_id, COUNT(*) AS cnt FROM fallback_logs GROUP BY from_model_id`)
      .all() as Array<{ model_id: string; cnt: number }>) {
      fallbackFrom.set(row.model_id, Number(row.cnt));
    }
    const fallbackTo = new Map<string, number>();
    for (const row of this.opts.db
      .prepare(`SELECT to_model_id AS model_id, COUNT(*) AS cnt FROM fallback_logs GROUP BY to_model_id`)
      .all() as Array<{ model_id: string; cnt: number }>) {
      fallbackTo.set(row.model_id, Number(row.cnt));
    }

    for (const row of rows) {
      const calls = Number(row.calls);
      const errors = Number(row.errors);
      hints[row.model_id] = {
        calls,
        errors,
        errorRate: calls === 0 ? 0 : errors / calls,
        fallbackFromCount: fallbackFrom.get(row.model_id) ?? 0,
        fallbackToCount: fallbackTo.get(row.model_id) ?? 0,
      };
    }
    return hints;
  }
}
