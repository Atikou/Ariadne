/**
 * 简易 unified diff（行级），供 write_file / apply_patch / diff_file 使用。
 */
export function buildUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
): string {
  if (oldContent === newContent) {
    return `（${filePath} 内容无变化）`;
  }
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  const header = `--- a/${filePath}\n+++ b/${filePath}\n`;
  const removed = oldLines.map((l) => `- ${l}`).join("\n");
  const added = newLines.map((l) => `+ ${l}`).join("\n");
  return `${header}@@ ${oldLines.length} → ${newLines.length} 行 @@\n${removed}\n${added}`;
}

/** 截断过长 diff 文本。 */
export function truncateDiff(diff: string, maxChars = 50_000): { diff: string; truncated: boolean } {
  if (diff.length <= maxChars) return { diff, truncated: false };
  return {
    diff: `${diff.slice(0, maxChars)}\n... (diff 已截断)`,
    truncated: true,
  };
}
