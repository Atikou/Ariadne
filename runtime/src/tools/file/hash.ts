import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** 计算字符串内容的 sha256（hex）。 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** 读取文件并计算 sha256；文件不存在时返回 null。 */
export async function hashFile(fullPath: string): Promise<string | null> {
  return await new Promise<string | null>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(fullPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") resolve(null);
      else reject(error);
    });
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
