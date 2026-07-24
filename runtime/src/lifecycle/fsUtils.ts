import {
  existsSync,
  lstatSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface WalkedFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export function fileAgeDays(mtimeMs: number, nowMs = Date.now()): number {
  return (nowMs - mtimeMs) / (24 * 60 * 60 * 1000);
}

export function walkFiles(root: string, opts?: { maxDepth?: number }): WalkedFile[] {
  if (!existsSync(root)) return [];
  const maxDepth = opts?.maxDepth ?? 32;
  const out: WalkedFile[] = [];

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
    }
  };

  visit(root, 0);
  return out;
}

export function dirTotalBytes(root: string): number {
  return walkFiles(root).reduce((sum, f) => sum + f.size, 0);
}

export function safeDeleteFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  unlinkSync(filePath);
}

export function safeDeleteDirectory(dirPath: string): void {
  if (!existsSync(dirPath)) return;
  rmSync(dirPath, { recursive: true, force: true });
}

/** tmp 写入后原子 rename 替换目标文件。 */
export function atomicWriteFile(targetPath: string, content: string | Buffer): void {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  if (typeof content === "string") {
    writeFileSync(tmpPath, content, "utf-8");
  } else {
    writeFileSync(tmpPath, content);
  }
  renameSync(tmpPath, targetPath);
}

export function fileSizeIfExists(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
