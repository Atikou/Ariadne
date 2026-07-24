import type { ModelClient } from "../model/types.js";

export interface ModelAvailabilityRecord {
  modelId: string;
  available: boolean;
  checkedAt: string;
  reason?: string;
  unavailableUntil?: string;
}

export interface ModelAvailabilityOptions {
  unavailableTtlMs?: number;
  probeTtlMs?: number;
}

export class ModelUnavailableError extends Error {
  constructor(
    readonly modelId: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export class ModelAvailabilityRegistry {
  private readonly records = new Map<string, ModelAvailabilityRecord>();
  private readonly inFlight = new Map<string, Promise<ModelAvailabilityRecord>>();
  private readonly unavailableTtlMs: number;
  private readonly probeTtlMs: number;

  constructor(options: ModelAvailabilityOptions = {}) {
    this.unavailableTtlMs = options.unavailableTtlMs ?? 120_000;
    this.probeTtlMs = options.probeTtlMs ?? 60_000;
  }

  isAllowed(modelId: string): boolean {
    const record = this.records.get(modelId);
    if (!record) return true;
    if (record.available) return true;
    if (record.unavailableUntil && Date.now() >= Date.parse(record.unavailableUntil)) {
      this.records.delete(modelId);
      return true;
    }
    return false;
  }

  shouldProbe(modelId: string): boolean {
    const record = this.records.get(modelId);
    if (!record) return true;
    if (!record.available) return !record.unavailableUntil || Date.now() >= Date.parse(record.unavailableUntil);
    return Date.now() - Date.parse(record.checkedAt) >= this.probeTtlMs;
  }

  markAvailable(modelId: string): ModelAvailabilityRecord {
    const record: ModelAvailabilityRecord = {
      modelId,
      available: true,
      checkedAt: new Date().toISOString(),
    };
    this.records.set(modelId, record);
    return record;
  }

  markUnavailable(modelId: string, reason: string, ttlMs = this.unavailableTtlMs): ModelAvailabilityRecord {
    const now = Date.now();
    const record: ModelAvailabilityRecord = {
      modelId,
      available: false,
      checkedAt: new Date(now).toISOString(),
      reason,
      unavailableUntil: new Date(now + ttlMs).toISOString(),
    };
    this.records.set(modelId, record);
    return record;
  }

  refreshModel(modelId: string, client: ModelClient): Promise<ModelAvailabilityRecord> {
    const running = this.inFlight.get(modelId);
    if (running) return running;

    const cached = this.records.get(modelId);
    if (cached && !this.shouldProbe(modelId)) return Promise.resolve(cached);

    const probe = Promise.resolve()
      .then(() => client.isAvailable())
      .then((available) => available
        ? this.markAvailable(modelId)
        : this.markUnavailable(modelId, "client.isAvailable() returned false"))
      .finally(() => {
        if (this.inFlight.get(modelId) === probe) this.inFlight.delete(modelId);
      });
    this.inFlight.set(modelId, probe);
    return probe;
  }

  async refreshAll(clientMap: Map<string, ModelClient>): Promise<ModelAvailabilityRecord[]> {
    const entries = [...clientMap.entries()].map(([modelId, client]) => this.refreshModel(modelId, client));
    return Promise.all(entries);
  }

  get(modelId: string): ModelAvailabilityRecord | undefined {
    return this.records.get(modelId);
  }

  snapshot(): ModelAvailabilityRecord[] {
    return [...this.records.values()];
  }
}

export function isModelUnavailableError(error: unknown): error is ModelUnavailableError {
  return error instanceof ModelUnavailableError;
}

export function looksLikeModelUnavailableError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return (
    text.includes("model") &&
    (text.includes("not found") || text.includes("404") || text.includes("not available") || text.includes("unavailable"))
  );
}
