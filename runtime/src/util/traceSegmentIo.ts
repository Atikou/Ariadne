import { createReadStream, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createGunzip, gunzipSync, gzipSync } from "node:zlib";

const DEFAULT_TAIL_CHUNK_BYTES = 64 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

export function isGzipTraceSegment(filePath: string): boolean {
  return filePath.endsWith(".gz");
}

/** 将明文 segment gzip 压缩为 `{path}.gz` 并删除原文件；返回 gzip 绝对路径。 */
export function gzipTraceSegmentInPlace(plainPath: string): string {
  const gzPath = `${plainPath}.gz`;
  writeFileSync(gzPath, gzipSync(readFileSync(plainPath)));
  unlinkSync(plainPath);
  return gzPath;
}

export function readTraceSegmentUtf8(filePath: string): string {
  if (isGzipTraceSegment(filePath)) {
    return gunzipSync(readFileSync(filePath)).toString("utf-8");
  }
  return readFileSync(filePath, "utf-8");
}

/** 流式读取 trace segment（明文 UTF-8 或 gzip）。 */
export function createTraceSegmentReadStream(filePath: string): NodeJS.ReadableStream {
  if (isGzipTraceSegment(filePath)) {
    return createReadStream(filePath).pipe(createGunzip());
  }
  return createReadStream(filePath, { encoding: "utf-8" });
}

/** 读取 trace 段尾部行（支持 .jsonl 与 .jsonl.gz）。 */
export function readTraceTailLines(filePath: string, limit: number): string[] {
  if (isGzipTraceSegment(filePath)) {
    const text = readTraceSegmentUtf8(filePath);
    return text.split("\n").filter((line) => line.trim().length > 0).slice(-limit);
  }

  const fd = openSync(filePath, "r");
  try {
    const size = fstatSync(fd).size;
    let position = size;
    let text = "";
    let bytesReadTotal = 0;
    while (position > 0 && bytesReadTotal < MAX_TAIL_BYTES) {
      const chunkSize = Math.min(DEFAULT_TAIL_CHUNK_BYTES, position, MAX_TAIL_BYTES - bytesReadTotal);
      position -= chunkSize;
      const buf = Buffer.allocUnsafe(chunkSize);
      const bytesRead = readSync(fd, buf, 0, chunkSize, position);
      text = buf.subarray(0, bytesRead).toString("utf-8") + text;
      bytesReadTotal += bytesRead;
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      if (lines.length > limit) return lines.slice(-limit);
      if (bytesRead === 0) break;
    }
    return text.split("\n").filter((line) => line.trim().length > 0).slice(-limit);
  } finally {
    closeSync(fd);
  }
}
