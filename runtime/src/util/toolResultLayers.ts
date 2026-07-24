/**
 * 工具结果三层：raw（审计）/ modelVisible（回灌模型）/ userDisplay（用户展示）。
 *
 * 纯数据整形助手，无任何上层依赖；放在 util/ 作为最底层，供 agent/ 与 context/
 * 同时依赖，避免 context/ 反向 import agent/（消除层序倒置）。
 */

export const DEFAULT_LARGE_TOOL_CHARS = 4000;
export const MODEL_TOOL_RESULT_MAX_CHARS = 4000;

/** JSON.stringify(undefined) 返回 undefined，不能直接读 .length。 */
export function jsonSerializedLength(value: unknown): number {
  return (JSON.stringify(value) ?? "null").length;
}

export interface ToolUserDisplay {
  tool: string;
  truncated: boolean;
  summary: string;
  itemCount?: number;
  originalBytes?: number;
}

export interface ToolResultLayers {
  raw: unknown;
  modelVisible: unknown;
  userDisplay: ToolUserDisplay;
  rawJsonLength: number;
  modelJsonLength: number;
}

export function compactToolOutputForModel(
  tool: string,
  output: unknown,
  largeToolChars = DEFAULT_LARGE_TOOL_CHARS,
): { modelVisible: unknown; truncated: boolean } {
  const json = JSON.stringify(output) ?? "null";
  if (json.length <= largeToolChars) {
    return { modelVisible: output, truncated: false };
  }
  return {
    modelVisible: {
      _truncated: true,
      tool,
      preview: `${json.slice(0, 800)}…`,
      note: "完整输出已截断；如需全文请用 read_file 重新读取对应路径。",
      originalLength: json.length,
    },
    truncated: true,
  };
}

export function isModelCompactTruncated(modelVisible: unknown): boolean {
  return Boolean(
    modelVisible &&
      typeof modelVisible === "object" &&
      "_truncated" in (modelVisible as Record<string, unknown>),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildUserToolDisplay(
  tool: string,
  raw: unknown,
  modelTruncated: boolean,
): ToolUserDisplay {
  const record = asRecord(raw);
  const toolTruncated = record?.truncated === true;
  const truncated = toolTruncated || modelTruncated;
  const originalBytes = jsonSerializedLength(raw);

  if (tool === "list_files" && Array.isArray(record?.files)) {
    const count = record.files.length;
    const root = typeof record.root === "string" ? record.root : ".";
    return {
      tool,
      truncated,
      itemCount: count,
      originalBytes,
      summary: truncated
        ? `列出 ${count} 个条目（root=${root}），结果已截断；完整列表见 trace / tool_logs。`
        : `列出 ${count} 个条目（root=${root}）。`,
    };
  }

  if (tool === "search_text" && Array.isArray(record?.results)) {
    const count = record.results.length;
    const query = typeof record.query === "string" ? record.query : "";
    return {
      tool,
      truncated,
      itemCount: count,
      originalBytes,
      summary: truncated
        ? `搜索「${query}」命中 ${count} 条，结果已截断。`
        : `搜索「${query}」命中 ${count} 条。`,
    };
  }

  if (tool === "read_file" && typeof record?.path === "string") {
    const path = record.path;
    if (record.found === false) {
      const obs = asRecord(record.outcome);
      const kind = typeof obs?.kind === "string" ? obs.kind : "not_found";
      return {
        tool,
        truncated: false,
        originalBytes: jsonSerializedLength(raw),
        summary: `观察失败：${kind} — ${path}（${typeof obs?.message === "string" ? obs.message : "目标状态不满足"}）`,
      };
    }
    const contentLen = typeof record.content === "string" ? record.content.length : 0;
    return {
      tool,
      truncated,
      itemCount: contentLen,
      originalBytes,
      summary: truncated
        ? `读取 ${path}（${contentLen} 字符），内容已截断。`
        : `读取 ${path}（${contentLen} 字符）。`,
    };
  }

  return {
    tool,
    truncated,
    originalBytes,
    summary: truncated
      ? `工具 ${tool} 返回 ${originalBytes} 字节 JSON，模型侧已截断。`
      : `工具 ${tool} 返回 ${originalBytes} 字节 JSON。`,
  };
}

export function buildToolResultLayers(
  tool: string,
  raw: unknown,
  opts?: {
    largeToolChars?: number;
    compact?: (tool: string, output: unknown) => unknown;
  },
): ToolResultLayers {
  const largeToolChars = opts?.largeToolChars ?? DEFAULT_LARGE_TOOL_CHARS;
  let modelVisible: unknown;
  let modelTruncated: boolean;
  if (opts?.compact) {
    modelVisible = opts.compact(tool, raw);
    modelTruncated = isModelCompactTruncated(modelVisible);
  } else {
    const compacted = compactToolOutputForModel(tool, raw, largeToolChars);
    modelVisible = compacted.modelVisible;
    modelTruncated = compacted.truncated;
  }

  const rawJsonLength = jsonSerializedLength(raw);
  const modelJsonLength = jsonSerializedLength(modelVisible);

  return {
    raw,
    modelVisible,
    userDisplay: buildUserToolDisplay(tool, raw, modelTruncated),
    rawJsonLength,
    modelJsonLength,
  };
}

export function clipModelToolJson(modelVisible: unknown, maxChars = MODEL_TOOL_RESULT_MAX_CHARS): string {
  const json = JSON.stringify(modelVisible) ?? "null";
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}…(已截断)`;
}
