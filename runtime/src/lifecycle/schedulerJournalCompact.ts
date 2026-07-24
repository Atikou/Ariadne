import { readFileSync } from "node:fs";

import { atomicWriteFile } from "./fsUtils.js";

/** 将 scheduler journal 压紧为每个 trigger 仅保留最终 upsert 行。 */
export function compactSchedulerJournalFile(filePath: string): number {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return 0;
  }
  if (!text.trim()) return 0;

  const lines = text.split("\n").filter(Boolean);
  const triggers = new Map<string, string>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as {
        op?: string;
        id?: string;
        trigger?: { id?: string };
      };
      if (parsed.op === "delete" && typeof parsed.id === "string") {
        triggers.delete(parsed.id);
        continue;
      }
      if (parsed.op === "upsert" && parsed.trigger?.id) {
        triggers.set(parsed.trigger.id, line);
      }
    } catch {
      continue;
    }
  }
  const kept = [...triggers.values()];
  const next = kept.length > 0 ? `${kept.join("\n")}\n` : "";
  const removedBytes = Math.max(0, Buffer.byteLength(text, "utf-8") - Buffer.byteLength(next, "utf-8"));
  if (removedBytes > 0) {
    atomicWriteFile(filePath, next);
  }
  return removedBytes;
}
