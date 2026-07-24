import path from "node:path";

import { canonicalizePathIdentity } from "../platform/pathIdentity.js";
import { inspectStorageRootBoundary } from "../platform/storageRootPolicy.js";
import { CompanionStorage } from "./CompanionStorage.js";

const DEFAULT_CACHE_LIMIT = 16;

/** Validates storage roots and owns the bounded set of live SQLite connections. */
export class CompanionStorageManager {
  private readonly cache = new Map<string, CompanionStorage>();
  private readonly accessListeners = new Set<(storage: CompanionStorage) => void>();
  private readonly defaultRoot: string;
  private readonly cacheLimit: number;

  constructor(
    private readonly projectRoot: string,
    defaultRoot = path.join(projectRoot, ".ariadne", "companion"),
  ) {
    this.defaultRoot = this.canonicalize(defaultRoot);
    this.assertAllowedRoot(this.defaultRoot);
    this.cacheLimit = parseCacheLimit(process.env.COMPANION_STORAGE_CACHE_MAX);
  }

  resolveStorageRoot(input?: string): string {
    const raw = input?.trim();
    if (!raw) return this.defaultRoot;
    if (raw.length > 1_024 || raw.includes("\0")) {
      throw new Error("invalid_companion_storage_root");
    }
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(this.projectRoot, raw);
    const canonical = this.canonicalize(resolved);
    this.assertAllowedRoot(canonical);
    return canonical;
  }

  resolveUnrestrictedMemoryRoot(input?: string): string {
    return path.join(this.resolveStorageRoot(input), "unrestricted-memory");
  }

  get(input?: string): CompanionStorage {
    const root = this.resolveStorageRoot(input);
    const key = cacheKey(root);
    const cached = this.cache.get(key);
    if (cached) {
      this.notifyAccess(cached);
      return cached;
    }
    if (this.cache.size >= this.cacheLimit) {
      throw new Error(`companion_storage_cache_limit_reached:${this.cacheLimit}`);
    }
    const storage = new CompanionStorage(root);
    this.cache.set(key, storage);
    this.notifyAccess(storage);
    return storage;
  }

  onAccess(listener: (storage: CompanionStorage) => void): () => void {
    this.accessListeners.add(listener);
    return () => this.accessListeners.delete(listener);
  }

  getUnrestrictedMemory(input?: string): CompanionStorage {
    return this.get(this.resolveUnrestrictedMemoryRoot(input));
  }

  close(input: string): boolean {
    const root = this.resolveStorageRoot(input);
    const roots = [root, this.resolveUnrestrictedMemoryRoot(root)].map(cacheKey);
    let closed = false;
    const errors: unknown[] = [];
    for (const key of roots) {
      const storage = this.cache.get(key);
      if (!storage) continue;
      this.cache.delete(key);
      closed = true;
      try {
        storage.close();
      } catch (error) {
        errors.push(error);
      }
    }
    throwCloseErrors(errors);
    return closed;
  }

  status(): { openStorages: number; maxOpenStorages: number; defaultRoot: string } {
    return {
      openStorages: this.cache.size,
      maxOpenStorages: this.cacheLimit,
      defaultRoot: this.defaultRoot,
    };
  }

  closeAll(): void {
    const storages = [...this.cache.values()];
    this.cache.clear();
    const errors: unknown[] = [];
    for (const storage of storages) {
      try {
        storage.close();
      } catch (error) {
        errors.push(error);
      }
    }
    throwCloseErrors(errors);
  }

  private notifyAccess(storage: CompanionStorage): void {
    for (const listener of this.accessListeners) {
      try {
        listener(storage);
      } catch {
        // Storage access must remain available while durable recovery retries later.
      }
    }
  }

  private canonicalize(target: string): string {
    return canonicalizePathIdentity(target);
  }

  private assertAllowedRoot(root: string): void {
    const violation = inspectStorageRootBoundary(root);
    if (violation?.kind === "filesystem_root") {
      throw new Error("companion_storage_root_cannot_be_filesystem_root");
    }
    if (violation?.kind === "protected_system_path") {
      throw new Error(
        `companion_storage_root_is_protected_system_path:${violation.protectedRoot}`,
      );
    }
  }
}

function throwCloseErrors(errors: unknown[]): void {
  if (errors.length === 0) return;
  throw new AggregateError(errors, "companion_storage_close_failed");
}

function cacheKey(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function parseCacheLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_CACHE_LIMIT;
  return Math.min(64, Math.max(2, parsed));
}
