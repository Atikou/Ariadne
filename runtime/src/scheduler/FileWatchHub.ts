import chokidar, { type FSWatcher } from "chokidar";
import { statSync } from "node:fs";
import path from "node:path";

import { canonicalizeExistingPath } from "../policy/WorkspaceScopeManager.js";
import { resolveInsideWorkspace } from "../tools/pathSafe.js";

export type FileWatchEventKind = "add" | "change" | "unlink";

export interface FileWatchEvent {
  relativePath: string;
  kind: FileWatchEventKind;
}

/**
 * 工作区内文件监听复用 hub：同一路径只开一个 chokidar 实例。
 */
export class FileWatchHub {
  private readonly roots = new Map<
    string,
    { watcher: FSWatcher; listeners: Set<(event: FileWatchEvent) => void> }
  >();

  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = canonicalizeExistingPath(workspaceRoot);
  }

  validateWatchPath(watchPath: string): void {
    this.resolveWatchPath(watchPath);
  }

  subscribe(watchPath: string, listener: (event: FileWatchEvent) => void): () => void {
    const absDir = this.resolveWatchPath(watchPath);
    const key = absDir;
    let entry = this.roots.get(key);
    if (!entry) {
      const watcher = chokidar.watch(absDir, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
      });
      entry = { watcher, listeners: new Set() };
      this.roots.set(key, entry);
      watcher.on("all", (kind, filePath) => {
        if (kind !== "add" && kind !== "change" && kind !== "unlink") return;
        const relativePath = path.relative(this.workspaceRoot, filePath).replace(/\\/g, "/");
        const payload: FileWatchEvent = { relativePath, kind };
        for (const fn of entry!.listeners) {
          fn(payload);
        }
      });
    }
    entry.listeners.add(listener);
    return () => {
      const current = this.roots.get(key);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        void current.watcher.close();
        this.roots.delete(key);
      }
    };
  }

  closeAll(): void {
    for (const entry of this.roots.values()) {
      void entry.watcher.close();
    }
    this.roots.clear();
  }

  private resolveWatchPath(watchPath: string): string {
    const resolved = resolveInsideWorkspace(this.workspaceRoot, watchPath || ".");
    if (!statSync(resolved).isDirectory()) {
      throw new Error(`监听路径不是目录：${watchPath}`);
    }
    return canonicalizeExistingPath(resolved);
  }
}

/** 简单 glob：仅支持 `*` 通配；无 `/` 时只匹配文件名，含 `/` 时匹配相对路径。 */
export function matchFilePattern(relativePath: string, pattern?: string): boolean {
  if (!pattern) return true;
  const norm = relativePath.replace(/\\/g, "/");
  const subject = pattern.includes("/") ? norm : (norm.split("/").pop() ?? norm);
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
  );
  return re.test(subject);
}
