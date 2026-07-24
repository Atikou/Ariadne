import path from "node:path";

import type { AppConfig } from "./types.js";

const CUSTOM_WORKSPACE_PREFIX = "custom:";

export interface WorkspaceCatalogEntry {
  id: string;
  label: string;
  /** 配置中的原始 root（相对 Ariadne 项目根或绝对路径）。 */
  root: string;
  /** 解析后的绝对路径。 */
  resolvedRoot: string;
}

export interface WorkspaceCatalog {
  defaultKey: string;
  defaultRoot: string;
  entries: WorkspaceCatalogEntry[];
  byId: ReadonlyMap<string, WorkspaceCatalogEntry>;
}

export function buildWorkspaceCatalog(projectRoot: string, config: AppConfig): WorkspaceCatalog {
  const defaultRoot = path.resolve(projectRoot, config.workspaceRoot);
  const raw =
    config.workspaces && config.workspaces.length > 0
      ? config.workspaces
      : [{ id: "default", label: "默认工作区", root: config.workspaceRoot }];

  const entries: WorkspaceCatalogEntry[] = raw.map((item) => ({
    id: item.id,
    label: item.label,
    root: item.root,
    resolvedRoot: path.isAbsolute(item.root)
      ? path.resolve(item.root)
      : path.resolve(projectRoot, item.root),
  }));

  const byId = new Map(entries.map((e) => [e.id, e]));
  const defaultKey = entries[0]?.id ?? "default";
  return { defaultKey, defaultRoot, entries, byId };
}

export function resolveWorkspaceRootFromCatalog(
  catalog: WorkspaceCatalog,
  workspaceKey?: string,
): string {
  const key = workspaceKey?.trim();
  if (!key) return catalog.defaultRoot;
  const customRoot = decodeCustomWorkspaceKey(key);
  if (customRoot) return customRoot;
  return catalog.byId.get(key)?.resolvedRoot ?? catalog.defaultRoot;
}

export function encodeCustomWorkspaceRoot(workspaceRoot: string): string {
  const normalized = path.resolve(workspaceRoot);
  return `${CUSTOM_WORKSPACE_PREFIX}${Buffer.from(normalized, "utf8").toString("base64url")}`;
}

export function decodeCustomWorkspaceKey(workspaceKey?: string): string | undefined {
  const key = workspaceKey?.trim();
  if (!key?.startsWith(CUSTOM_WORKSPACE_PREFIX)) return undefined;
  const encoded = key.slice(CUSTOM_WORKSPACE_PREFIX.length);
  if (!encoded) return undefined;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8").trim();
    return decoded ? path.resolve(decoded) : undefined;
  } catch {
    return undefined;
  }
}
