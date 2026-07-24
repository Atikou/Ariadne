import fs from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_IGNORED_DIRS } from "./constants.js";

/**
 * 把相对/绝对路径解析为工作区内的绝对路径；越界则抛错。
 *
 * 用 path.relative 判断，避免 startsWith 在大小写/前缀场景下被绕过。
 */
export function resolveInsideWorkspace(workspaceRoot: string, target: string): string {
  const root = path.resolve(workspaceRoot);
  const full = path.resolve(root, target);
  const rel = path.relative(root, full);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  if (!inside) {
    throw new Error(`禁止访问工作区之外的路径：${target}`);
  }
  const resolved = resolveExistingRealpathSync(full);
  if (resolved) {
    const resolvedRoot = resolveExistingRealpathSync(root) ?? root;
    const realRel = path.relative(resolvedRoot, resolved);
    const realInside = realRel === "" || (!realRel.startsWith("..") && !path.isAbsolute(realRel));
    if (!realInside) {
      throw new Error(`禁止访问工作区之外的路径（符号链接）：${target}`);
    }
  }
  return full;
}

/** 规范别名。 */
export const assertInsideWorkspace = resolveInsideWorkspace;

/** 对已存在路径做 realpath，防止符号链接逃逸（Windows 短路径/junction 需同时解析 root）。 */
export async function resolveInsideWorkspaceAsync(
  workspaceRoot: string,
  target: string,
): Promise<string> {
  const full = resolveInsideWorkspace(workspaceRoot, target);
  try {
    const { realpath } = await import("node:fs/promises");
    const root = path.resolve(workspaceRoot);
    let resolvedRoot = root;
    try {
      resolvedRoot = await realpath(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    try {
      const resolved = await realpath(full);
      const rel = path.relative(resolvedRoot, resolved);
      const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      if (!inside) {
        throw new Error(`禁止访问工作区之外的路径（符号链接）：${target}`);
      }
      return resolved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return full;
      throw err;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return full;
    throw err;
  }
}

/** 目录名是否在默认忽略列表中。 */
export function shouldIgnoreDir(name: string, extra?: Set<string>): boolean {
  if (extra?.has(name)) return true;
  return DEFAULT_IGNORED_DIRS.has(name);
}

/** 将绝对路径转为相对工作区的展示路径（用于错误信息，避免泄露 workspaceRoot）。 */
export function toWorkspaceRelativePath(workspaceRoot: string, target: string): string {
  const root = path.resolve(workspaceRoot);
  const full = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
  const rel = path.relative(root, full);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return rel.replace(/\\/g, "/") || ".";
  }
  return path.basename(target).replace(/\\/g, "/");
}

/**
 * 从工具错误文案中剥离 workspaceRoot，并把其下的绝对路径改写为相对路径。
 */
export function sanitizeWorkspacePathsInError(workspaceRoot: string, message: string): string {
  const root = path.resolve(workspaceRoot);
  let out = message;

  const relativize = (absLike: string): string | null => {
    try {
      const full = path.isAbsolute(absLike) ? path.resolve(absLike) : path.resolve(root, absLike);
      const rel = path.relative(root, full);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        return rel.replace(/\\/g, "/") || ".";
      }
    } catch {
      // ignore
    }
    return null;
  };

  out = out.replace(/(['"])([^'"]+)\1/g, (match, quote: string, inner: string) => {
    const rel = relativize(inner);
    return rel != null ? `${quote}${rel}${quote}` : match;
  });

  const rootEsc = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  out = out.replace(new RegExp(rootEsc + "[/\\\\]?", "gi"), "");

  out = out
    .replace(/Error:\s*ENOENT:[^,]+,\s*stat\s+''/i, "ENOENT: 文件不存在")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (/ENOENT/i.test(out) && /no such file|文件不存在/i.test(out)) {
    const statMatch = out.match(/stat\s+['"]?([^'"]+)['"]?/i);
    const rel = statMatch?.[1] ? relativize(statMatch[1]) ?? statMatch[1].replace(/\\/g, "/") : null;
    if (rel) return `文件不存在：${rel}`;
  }

  return out;
}

/** 目标必须是普通文件。displayPath 为工作区相对路径，用于错误展示。 */
export async function assertIsFile(fullPath: string, displayPath?: string): Promise<void> {
  const label = displayPath?.replace(/\\/g, "/") ?? fullPath;
  try {
    const s = await stat(fullPath);
    if (!s.isFile()) throw new Error(`不是文件：${label}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`文件不存在：${label}`);
    throw err;
  }
}

function resolveExistingRealpathSync(target: string): string | undefined {
  let current = path.resolve(target);
  while (true) {
    try {
      return fs.realpathSync.native(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}
