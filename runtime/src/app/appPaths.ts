import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { canonicalizePathIdentity } from "../platform/pathIdentity.js";
import {
  inspectStorageRootBoundary,
  pathsOverlap,
} from "../platform/storageRootPolicy.js";

export type AppPathLayout = "source_tree" | "external_app_data";

export interface AppPaths {
  layout: AppPathLayout;
  projectRoot: string;
  repoRoot: string;
  publicDir: string;
  docsDir: string;
  docsAssetsDir: string;
  appDataRoot: string;
  dataDir: string;
  companionDataDir: string;
  tracesDir: string;
  traceFile: string;
}

export interface ResolveAppPathsOptions {
  projectRoot: string;
  appDataRoot?: string;
  requireExternalAppDataRoot?: boolean;
}

export function resolveAppPaths(options: ResolveAppPathsOptions): AppPaths {
  const projectRoot = path.resolve(options.projectRoot);
  const repoRoot = path.resolve(projectRoot, "..");
  const requestedRoot = options.appDataRoot?.trim();
  if (!requestedRoot) {
    if (options.requireExternalAppDataRoot) {
      throw new Error("external app data root is required");
    }
    const dataDir = path.join(projectRoot, "data");
    return buildPaths({
      layout: "source_tree",
      projectRoot,
      repoRoot,
      appDataRoot: projectRoot,
      dataDir,
      companionDataDir: path.join(projectRoot, ".ariadne", "companion"),
    });
  }

  if (requestedRoot.length > 1_024 || requestedRoot.includes("\0")) {
    throw new Error("invalid external app data root");
  }
  if (!path.isAbsolute(requestedRoot)) {
    throw new Error("external app data root must be absolute");
  }
  if (
    process.platform === "win32" &&
    (requestedRoot.startsWith("\\\\") || requestedRoot.startsWith("//"))
  ) {
    throw new Error("external app data root must be a local drive path");
  }

  const appDataRoot = canonicalizePathIdentity(requestedRoot);
  assertExternalAppDataRoot(appDataRoot, projectRoot, repoRoot);
  const dataDir = path.join(appDataRoot, "data");
  return buildPaths({
    layout: "external_app_data",
    projectRoot,
    repoRoot,
    appDataRoot,
    dataDir,
    companionDataDir: path.join(appDataRoot, "companion"),
  });
}

function buildPaths(input: {
  layout: AppPathLayout;
  projectRoot: string;
  repoRoot: string;
  appDataRoot: string;
  dataDir: string;
  companionDataDir: string;
}): AppPaths {
  return {
    ...input,
    publicDir: path.join(input.projectRoot, "public"),
    docsDir: path.join(input.repoRoot, "docs"),
    docsAssetsDir: path.join(input.repoRoot, "docs", "assets"),
    tracesDir: path.join(input.dataDir, "traces"),
    traceFile: path.join(input.dataDir, "traces", "active", "trace-current.jsonl"),
  };
}

function assertExternalAppDataRoot(
  appDataRoot: string,
  projectRoot: string,
  repoRoot: string,
): void {
  const boundaryViolation = inspectStorageRootBoundary(appDataRoot);
  if (boundaryViolation?.kind === "filesystem_root") {
    throw new Error("external app data root cannot be a filesystem root");
  }
  if (boundaryViolation?.kind === "protected_system_path") {
    throw new Error(
      `external app data root is a protected system path: ${boundaryViolation.protectedRoot}`,
    );
  }
  if (existsSync(appDataRoot) && !statSync(appDataRoot).isDirectory()) {
    throw new Error("external app data root must be a directory");
  }

  const projectIdentity = canonicalizePathIdentity(projectRoot);
  const repoIdentity = canonicalizePathIdentity(repoRoot);
  if (
    pathsOverlap(appDataRoot, projectIdentity) ||
    pathsOverlap(appDataRoot, repoIdentity)
  ) {
    throw new Error("external app data root must not overlap the application tree");
  }
}
