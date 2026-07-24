import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

import type { ModelRouterProfileConfig } from "../../config/types.js";
import { canonicalizePathIdentity } from "../../platform/pathIdentity.js";
import { LocalModelManifestSchema, type LocalModelManifest } from "./modelManifest.js";
import type {
  LocalModelCatalogSnapshot,
  LocalModelDescriptor,
  LocalModelFormat,
} from "./types.js";

const IGNORED_SUFFIXES = [".part", ".partial", ".tmp", ".download", ".lock"];

/** Reads only model metadata. Model weights are never loaded during discovery. */
export class ModelDirectoryCatalog {
  private snapshotValue?: LocalModelCatalogSnapshot;

  constructor(
    readonly directory: string,
    private readonly options: { createIfMissing?: boolean } = {},
  ) {}

  current(): LocalModelCatalogSnapshot | undefined {
    return this.snapshotValue;
  }

  scanSync(): LocalModelCatalogSnapshot {
    if (this.options.createIfMissing !== false) {
      mkdirSync(this.directory, { recursive: true });
    }
    const canonicalRoot = canonicalizePathIdentity(this.directory);
    if (!existsSync(canonicalRoot)) {
      const snapshot: LocalModelCatalogSnapshot = {
        directory: canonicalRoot,
        scannedAt: new Date().toISOString(),
        models: [],
        errors: [],
      };
      this.snapshotValue = snapshot;
      return snapshot;
    }
    if (!statSync(canonicalRoot).isDirectory()) {
      throw new Error(`Models path is not a directory: ${canonicalRoot}`);
    }
    const entries = readdirSync(canonicalRoot, { withFileTypes: true });
    const models: LocalModelDescriptor[] = [];
    const errors: string[] = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || shouldIgnore(entry.name)) continue;
      const candidate = path.join(canonicalRoot, entry.name);
      try {
        const canonical = canonicalizePathIdentity(candidate);
        assertInside(canonicalRoot, canonical);
        const found = entry.isDirectory()
          ? inspectDirectory(canonicalRoot, canonical, entry.name)
          : entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")
            ? inspectGgufFile(canonicalRoot, canonical, entry.name)
            : undefined;
        if (found) models.push(found);
      } catch (error) {
        errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const snapshot: LocalModelCatalogSnapshot = {
      directory: canonicalRoot,
      scannedAt: new Date().toISOString(),
      models: ensureUniqueIds(models),
      errors,
    };
    this.snapshotValue = snapshot;
    return snapshot;
  }

  async scan(): Promise<LocalModelCatalogSnapshot> {
    return this.scanSync();
  }
}

function inspectGgufFile(
  root: string,
  filePath: string,
  filename: string,
): LocalModelDescriptor {
  assertInside(root, filePath);
  const info = statSync(filePath);
  const name = path.basename(filename, path.extname(filename));
  return descriptor({
    id: idFromName(name),
    displayName: name,
    format: "gguf",
    runtime: "llama.cpp",
    modelPath: filePath,
    sourcePath: filePath,
    sizeBytes: info.size,
    modifiedAt: info.mtime.toISOString(),
    status: info.size > 0 ? "ready" : "incomplete",
    error: info.size > 0 ? undefined : "GGUF 文件为空",
  });
}

function inspectDirectory(
  root: string,
  directory: string,
  directoryName: string,
): LocalModelDescriptor | undefined {
  assertInside(root, directory);
  const names = readdirSync(directory).filter((name) => !shouldIgnore(name));
  const manifest = readManifest(directory, names);
  const ggufFiles = names.filter((name) => name.toLowerCase().endsWith(".gguf")).sort();
  const safetensorsFiles = names
    .filter((name) => name.toLowerCase().endsWith(".safetensors"))
    .sort();
  const hasTransformersConfig = names.includes("config.json");
  const chosenRuntime = manifest?.runtime;

  if (chosenRuntime === "llama.cpp" || (!chosenRuntime && ggufFiles.length > 0)) {
    const selected = selectGgufFile(ggufFiles, manifest?.modelFile);
    if (!selected) {
      return invalidDirectory(
        directory,
        directoryName,
        "gguf",
        "llama.cpp",
        manifest,
        ggufFiles.length > 1
          ? "目录含多个 GGUF；请在 model.json 中指定 modelFile"
          : "未找到可加载的 GGUF 文件",
      );
    }
    const modelPath = resolveManifestChild(directory, selected);
    const info = statSync(modelPath);
    return descriptor({
      id: manifest?.id ?? idFromName(directoryName),
      displayName: manifest?.displayName ?? directoryName,
      format: "gguf",
      runtime: "llama.cpp",
      modelPath,
      sourcePath: directory,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      status: info.size > 0 ? "ready" : "incomplete",
      error: info.size > 0 ? undefined : "GGUF 文件为空",
      contextSize: manifest?.contextSize,
      gpuLayers: manifest?.gpuLayers,
      device: manifest?.device,
      routerProfile: manifest?.routerProfile,
      maxTokens: manifest?.maxTokens,
      timeoutMs: manifest?.timeoutMs,
      firstTokenTimeoutMs: manifest?.firstTokenTimeoutMs,
      tokenIdleTimeoutMs: manifest?.tokenIdleTimeoutMs,
    });
  }

  if (chosenRuntime === "transformers" || (!chosenRuntime && hasTransformersConfig)) {
    if (!hasTransformersConfig) {
      return invalidDirectory(directory, directoryName, "safetensors", "transformers", manifest, "缺少 config.json");
    }
    if (safetensorsFiles.length === 0) {
      return invalidDirectory(directory, directoryName, "safetensors", "transformers", manifest, "缺少 Safetensors 权重");
    }
    const stats = safetensorsFiles.map((name) => statSync(path.join(directory, name)));
    const totalSize = stats.reduce((sum, item) => sum + item.size, 0);
    const modifiedAt = new Date(Math.max(...stats.map((item) => item.mtimeMs))).toISOString();
    return descriptor({
      id: manifest?.id ?? idFromName(directoryName),
      displayName: manifest?.displayName ?? directoryName,
      format: "safetensors",
      runtime: "transformers",
      modelPath: directory,
      sourcePath: directory,
      sizeBytes: totalSize,
      modifiedAt,
      status: totalSize > 0 ? "ready" : "incomplete",
      error: totalSize > 0 ? undefined : "Safetensors 权重为空",
      contextSize: manifest?.contextSize,
      device: manifest?.device,
      routerProfile: manifest?.routerProfile,
      maxTokens: manifest?.maxTokens,
      timeoutMs: manifest?.timeoutMs,
      firstTokenTimeoutMs: manifest?.firstTokenTimeoutMs,
      tokenIdleTimeoutMs: manifest?.tokenIdleTimeoutMs,
    });
  }

  if (manifest) {
    return invalidDirectory(
      directory,
      directoryName,
      "safetensors",
      manifest.runtime ?? "transformers",
      manifest,
      "无法根据 model.json 识别模型格式",
    );
  }
  return undefined;
}

function readManifest(directory: string, names: string[]): LocalModelManifest | undefined {
  if (!names.includes("model.json")) return undefined;
  const raw = JSON.parse(readFileSync(path.join(directory, "model.json"), "utf8")) as unknown;
  const parsed = LocalModelManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`model.json 校验失败：${parsed.error.message}`);
  return parsed.data;
}

function selectGgufFile(files: string[], configured?: string): string | undefined {
  if (configured) return files.includes(configured) ? configured : undefined;
  const firstShard = files.find((name) => /-00001-of-\d+\.gguf$/i.test(name));
  if (firstShard) return firstShard;
  return files.length === 1 ? files[0] : undefined;
}

function resolveManifestChild(directory: string, child: string): string {
  const target = canonicalizePathIdentity(path.resolve(directory, child));
  assertInside(directory, target);
  return target;
}

function invalidDirectory(
  directory: string,
  name: string,
  format: LocalModelFormat,
  runtime: "llama.cpp" | "transformers",
  manifest: LocalModelManifest | undefined,
  error: string,
): LocalModelDescriptor {
  return descriptor({
    id: manifest?.id ?? idFromName(name),
    displayName: manifest?.displayName ?? name,
    format,
    runtime,
    modelPath: directory,
    sourcePath: directory,
    sizeBytes: 0,
    modifiedAt: new Date(0).toISOString(),
    status: "invalid",
    error,
    contextSize: manifest?.contextSize,
    gpuLayers: manifest?.gpuLayers,
    device: manifest?.device,
    routerProfile: manifest?.routerProfile,
    maxTokens: manifest?.maxTokens,
    timeoutMs: manifest?.timeoutMs,
    firstTokenTimeoutMs: manifest?.firstTokenTimeoutMs,
    tokenIdleTimeoutMs: manifest?.tokenIdleTimeoutMs,
  });
}

function descriptor(input: LocalModelDescriptor): LocalModelDescriptor {
  const defaultProfile: ModelRouterProfileConfig = {
    displayName: input.displayName,
    defaultLevel: 2,
    relativeCost: "free",
    canDraft: true,
    canReview: false,
    allowedRoles: ["primary", "draft"],
    supportsStreaming: true,
    capabilities: {
      text: true,
      code: true,
      toolCalling: false,
      jsonMode: false,
      image: false,
    },
    privacy: { local: true, remote: false, allowSensitive: true },
  };
  return {
    ...input,
    routerProfile: mergeRouterProfiles(defaultProfile, input.routerProfile),
  };
}

function mergeRouterProfiles(
  base: ModelRouterProfileConfig,
  override?: ModelRouterProfileConfig,
): ModelRouterProfileConfig {
  if (!override) return base;
  return {
    ...base,
    ...override,
    capabilities: { ...base.capabilities, ...override.capabilities },
    privacy: { ...base.privacy, ...override.privacy },
  };
}

function ensureUniqueIds(models: LocalModelDescriptor[]): LocalModelDescriptor[] {
  const seen = new Map<string, string>();
  return models.map((model) => {
    const prior = seen.get(model.id);
    if (!prior) {
      seen.set(model.id, model.sourcePath);
      return model;
    }
    const suffix = createHash("sha256").update(model.sourcePath).digest("hex").slice(0, 8);
    return { ...model, id: `${model.id}-${suffix}` };
  });
}

function idFromName(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || `model-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`模型路径越出 Models 目录：${target}`);
}

function shouldIgnore(name: string): boolean {
  const lower = name.toLowerCase();
  return IGNORED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
