import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

/** 计算字符串内容的 sha256（hex）。 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** 读取文件并计算 sha256；文件不存在时返回 null。 */
export async function hashFile(fullPath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(fullPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
