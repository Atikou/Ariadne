import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { lifecycleDir } from "./policy.js";

export class CleanupLock {
  private readonly lockFile: string;
  private readonly timeoutMs: number;
  private held = false;

  constructor(dataDir: string, timeoutSeconds: number) {
    const dir = path.join(lifecycleDir(dataDir), "locks");
    mkdirSync(dir, { recursive: true });
    this.lockFile = path.join(dir, "cleanup.lock");
    this.timeoutMs = timeoutSeconds * 1000;
  }

  acquire(): boolean {
    if (this.held) return true;
    if (existsSync(this.lockFile)) {
      try {
        const raw = JSON.parse(readFileSync(this.lockFile, "utf-8")) as { pid: number; startedAt: number };
        const age = Date.now() - raw.startedAt;
        if (age < this.timeoutMs) {
          return false;
        }
      } catch {
        // stale lock — overwrite below
      }
    }
    writeFileSync(
      this.lockFile,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
      "utf-8",
    );
    this.held = true;
    return true;
  }

  release(): void {
    if (!this.held) return;
    if (existsSync(this.lockFile)) {
      try {
        rmSync(this.lockFile, { force: true });
      } catch {
        // ignore
      }
    }
    this.held = false;
  }
}
