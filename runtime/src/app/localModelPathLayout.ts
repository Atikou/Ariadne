import path from "node:path";

import { canonicalizePathIdentity } from "../platform/pathIdentity.js";
import type { AppPaths } from "./appPaths.js";

export interface LocalModelPathLayout {
  primaryModelsDirectory: string;
  readOnlyModelDirectories: string[];
  transformersRuntimeDirectory: string;
  runtimeCacheDirectory: string;
}

export function resolveLocalModelPathLayout(
  paths: AppPaths,
  configuredModelsDirectory: string,
  hostModelDirectories: readonly string[] = [],
): LocalModelPathLayout {
  const transformersRuntimeDirectory = path.join(
    paths.projectRoot,
    ".runtime",
    "transformers",
  );

  if (paths.layout === "source_tree") {
    return {
      primaryModelsDirectory: path.resolve(configuredModelsDirectory),
      readOnlyModelDirectories: [],
      transformersRuntimeDirectory,
      runtimeCacheDirectory: path.join(
        paths.projectRoot,
        ".runtime",
        "model-cache",
      ),
    };
  }

  const readOnlyModelDirectories = uniqueCanonicalPaths([
    configuredModelsDirectory,
    ...hostModelDirectories,
  ]);

  return {
    primaryModelsDirectory: path.join(paths.appDataRoot, "models"),
    readOnlyModelDirectories,
    transformersRuntimeDirectory,
    runtimeCacheDirectory: path.join(paths.appDataRoot, "model-cache"),
  };
}

function uniqueCanonicalPaths(paths: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    const canonical = canonicalizePathIdentity(path.resolve(entry));
    const key = process.platform === "win32" ? canonical.toLocaleLowerCase() : canonical;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  return result;
}
