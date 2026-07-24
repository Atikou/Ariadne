import path from "node:path";

import { canonicalizePathIdentity } from "./pathIdentity.js";

export type StorageRootBoundaryViolation =
  | { kind: "filesystem_root" }
  | { kind: "protected_system_path"; protectedRoot: string };

export function inspectStorageRootBoundary(root: string): StorageRootBoundaryViolation | undefined {
  if (samePath(root, path.parse(root).root)) {
    return { kind: "filesystem_root" };
  }
  for (const protectedRoot of protectedSystemRoots()) {
    if (isPathInside(root, protectedRoot)) {
      return { kind: "protected_system_path", protectedRoot };
    }
  }
  return undefined;
}

export function pathsOverlap(left: string, right: string): boolean {
  return isPathInside(left, right) || isPathInside(right, left);
}

export function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function protectedSystemRoots(): string[] {
  if (process.platform === "win32") {
    return [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter((value): value is string => Boolean(value))
      .map((value) => canonicalizePathIdentity(value));
  }
  return ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/sbin", "/sys", "/usr"];
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}
