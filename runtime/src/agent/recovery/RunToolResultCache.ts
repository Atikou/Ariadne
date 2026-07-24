import { stableToolInputKey } from "./stableToolInputKey.js";



const CACHEABLE_TOOLS = new Set([

  "read_file",

  "list_files",

  "project_scan",

  "search_text",

  "locate_relevant_files",

  "symbol_search",

]);



export interface CachedToolResult {

  tool: string;

  inputKey: string;

  output: unknown;

  contentHash?: string;

  storedAt: string;

}



export interface RunToolCacheLookup {

  hit: true;

  entry: CachedToolResult;

}



/** Run 内只读工具结果缓存；写入成功后按路径失效。 */

export class RunToolResultCache {

  private readonly entries = new Map<string, CachedToolResult>();



  isCacheable(tool: string): boolean {

    return CACHEABLE_TOOLS.has(tool);

  }



  lookup(tool: string, input: Record<string, unknown>): RunToolCacheLookup | undefined {

    if (!this.isCacheable(tool)) return undefined;

    const key = stableToolInputKey(tool, input);

    const entry = this.entries.get(key);

    if (!entry) return undefined;

    return { hit: true, entry };

  }



  store(tool: string, input: Record<string, unknown>, output: unknown): void {

    if (!this.isCacheable(tool)) return;

    const key = stableToolInputKey(tool, input);

    const contentHash = tool === "read_file" ? hashReadFileOutput(output) : undefined;

    this.entries.set(key, {

      tool,

      inputKey: key,

      output,

      contentHash,

      storedAt: new Date().toISOString(),

    });

  }



  invalidatePath(targetPath: string): void {

    const normalized = targetPath.replace(/\\/g, "/");

    for (const [key, entry] of this.entries.entries()) {

      if (entry.tool === "read_file" && key.includes(`"path":"${normalized}"`)) {

        this.entries.delete(key);

      }

    }

  }



  invalidateAll(): void {
    this.entries.clear();
  }

  exportState(): CachedToolResult[] {
    return [...this.entries.values()];
  }

  restoreState(entries: CachedToolResult[]): void {
    this.entries.clear();
    for (const entry of entries) {
      this.entries.set(entry.inputKey, entry);
    }
  }
}



function hashReadFileOutput(output: unknown): string | undefined {

  if (!output || typeof output !== "object") return undefined;

  const record = output as Record<string, unknown>;

  if (typeof record.content !== "string") return undefined;

  const mtime = typeof record.mtimeMs === "number" ? String(record.mtimeMs) : "";

  return `${record.content.length}:${mtime}`;

}
