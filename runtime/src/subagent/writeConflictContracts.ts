export type WriteFilePickStrategy = "latest" | "earliest" | "arbitration";

export interface SubAgentWriteConflict {
  path: string;
  taskIds: string[];
  changeIds: string[];
  reason: string;
}

export function normalizeRelPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
