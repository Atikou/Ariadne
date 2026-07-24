import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Returns one stable filesystem identity for existing paths and future descendants.
 * On Windows the native realpath implementation expands 8.3 aliases to long names.
 */
export function canonicalizePathIdentity(inputPath: string): string {
  const absolute = path.resolve(inputPath);
  let current = absolute;
  const missingSegments: string[] = [];

  while (true) {
    try {
      const existingIdentity = realpathSync.native(current);
      return missingSegments.length > 0
        ? path.resolve(existingIdentity, ...missingSegments.reverse())
        : existingIdentity;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}
