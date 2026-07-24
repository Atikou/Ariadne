import { watch, type FSWatcher } from "chokidar";

import type { EmbeddedModelClientConfig } from "../../config/types.js";
import type { ModelClient } from "../types.js";
import { EmbeddedModelClient } from "./EmbeddedModelClient.js";
import { LocalModelRuntimeManager } from "./LocalModelRuntimeManager.js";
import { ModelDirectoryCatalog } from "./ModelDirectoryCatalog.js";
import { descriptorToClientConfig, type LocalModelCatalogSnapshot, type LocalModelDescriptor } from "./types.js";

export interface LocalModelServiceOptions {
  directory: string;
  readOnlyDirectories?: readonly string[];
  autoDiscover: boolean;
  watch: boolean;
  maxLoadedModels: number;
  idleUnloadMs: number;
  transformersRuntimeDirectory?: string;
  runtimeCacheDirectory?: string;
  reservedClientNames?: Iterable<string>;
  onChanged?: (snapshot: LocalModelCatalogSnapshot, clients: ModelClient[], configs: EmbeddedModelClientConfig[]) => void;
}

/** Models-directory discovery, hot refresh and embedded-runtime lifecycle. */
export class LocalModelService {
  readonly runtimes: LocalModelRuntimeManager;
  private readonly catalogs: ModelDirectoryCatalog[];
  private snapshotValue: LocalModelCatalogSnapshot;
  private clientsValue: ModelClient[] = [];
  private configsValue: EmbeddedModelClientConfig[] = [];
  private watcher?: FSWatcher;
  private refreshTimer?: NodeJS.Timeout;
  private started = false;

  constructor(private readonly options: LocalModelServiceOptions) {
    this.runtimes = new LocalModelRuntimeManager({
      maxLoadedModels: options.maxLoadedModels,
      idleUnloadMs: options.idleUnloadMs,
      transformersRuntimeDirectory: options.transformersRuntimeDirectory,
      runtimeCacheDirectory: options.runtimeCacheDirectory,
    });
    this.catalogs = [
      new ModelDirectoryCatalog(options.directory),
      ...(options.readOnlyDirectories ?? []).map(
        (directory) =>
          new ModelDirectoryCatalog(directory, { createIfMissing: false }),
      ),
    ];
    this.snapshotValue = options.autoDiscover
      ? this.withSafeIds(this.scanCatalogsSync())
      : {
          directory: options.directory,
          scannedAt: new Date().toISOString(),
          models: [],
          errors: [],
        };
    this.rebuildClients();
  }

  snapshot(): LocalModelCatalogSnapshot {
    return {
      ...this.snapshotValue,
      models: this.snapshotValue.models.map((model) => ({ ...model })),
      errors: [...this.snapshotValue.errors],
    };
  }

  clients(): ModelClient[] {
    return [...this.clientsValue];
  }

  clientConfigs(): EmbeddedModelClientConfig[] {
    return [...this.configsValue];
  }

  async refresh(): Promise<LocalModelCatalogSnapshot> {
    if (!this.options.autoDiscover) return this.snapshot();
    const before = new Map(this.snapshotValue.models.map((model) => [model.id, model]));
    this.snapshotValue = this.withSafeIds(await this.scanCatalogs());
    for (const [modelId, oldModel] of before) {
      const next = this.snapshotValue.models.find((model) => model.id === modelId);
      if (!next || next.modelPath !== oldModel.modelPath || next.modifiedAt !== oldModel.modifiedAt) {
        await this.runtimes.unload(modelId);
      }
    }
    this.rebuildClients();
    this.options.onChanged?.(this.snapshot(), this.clients(), this.clientConfigs());
    return this.snapshot();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.options.autoDiscover || !this.options.watch) return;
    this.watcher = watch(this.options.directory, {
      ignoreInitial: true,
      depth: 2,
      awaitWriteFinish: { stabilityThreshold: 1_500, pollInterval: 200 },
    });
    this.watcher.on("all", () => this.scheduleRefresh());
    this.watcher.on("error", (error) => {
      console.warn(`[local-model] Models 目录监听失败：${String(error)}`);
    });
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.started = false;
    await this.watcher?.close();
    this.watcher = undefined;
    await this.runtimes.dispose();
  }

  runtimeStatus(): ReturnType<LocalModelRuntimeManager["status"]> {
    return this.runtimes.status();
  }

  private rebuildClients(): void {
    const ready = this.snapshotValue.models.filter((model) => model.status === "ready");
    this.configsValue = ready.map(descriptorToClientConfig);
    this.clientsValue = ready.map((model) => new EmbeddedModelClient(model, this.runtimes));
  }

  private scanCatalogsSync(): LocalModelCatalogSnapshot {
    return this.mergeSnapshots(this.catalogs.map((catalog) => catalog.scanSync()));
  }

  private async scanCatalogs(): Promise<LocalModelCatalogSnapshot> {
    return this.mergeSnapshots(
      await Promise.all(this.catalogs.map((catalog) => catalog.scan())),
    );
  }

  private mergeSnapshots(
    snapshots: LocalModelCatalogSnapshot[],
  ): LocalModelCatalogSnapshot {
    const primary = snapshots[0];
    if (!primary) throw new Error("local model service requires a primary directory");
    return {
      directory: primary.directory,
      scannedAt: new Date().toISOString(),
      models: snapshots.flatMap((snapshot) => snapshot.models),
      errors: snapshots.flatMap((snapshot) =>
        snapshot.errors.map((error) => `${snapshot.directory}: ${error}`),
      ),
    };
  }

  private withSafeIds(snapshot: LocalModelCatalogSnapshot): LocalModelCatalogSnapshot {
    const used = new Set(this.options.reservedClientNames ?? []);
    const models = snapshot.models.map((model) => {
      let id = model.id;
      while (used.has(id)) id = `${id}-local`;
      used.add(id);
      return id === model.id ? model : { ...model, id };
    });
    return { ...snapshot, models };
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh().catch((error) => {
        console.warn(`[local-model] Models 目录刷新失败：${String(error)}`);
      });
    }, 300);
    this.refreshTimer.unref?.();
  }
}
