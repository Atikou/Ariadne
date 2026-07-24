import { randomUUID } from "node:crypto";

import type { DelegatedTask } from "./delegatedTask.js";
import { DEFAULT_READONLY_LIMITS, DEFAULT_READONLY_MODEL_POLICY, DEFAULT_READONLY_TOOL_POLICY, normalizeDelegatedTask } from "./delegatedTask.js";

/**
 * 将复杂目标拆成多个可并行执行的干净上下文子任务（启发式，非模型调用）。
 */
export class TaskSplitter {
  split(goal: string, opts?: { maxTasks?: number }): DelegatedTask[] {
    const maxTasks = opts?.maxTasks ?? 3;
    const text = goal.trim();
    if (!text) return [];

    const filePaths = extractFilePaths(text);
    if (filePaths.length >= 2 && filePaths.length <= maxTasks) {
      return filePaths.slice(0, maxTasks).map((file) =>
        normalizeDelegatedTask({
          id: randomUUID(),
          goal: `分析文件 ${file} 与当前任务相关的部分`,
          instructions: `聚焦 ${file}，完成父任务中的局部目标：${text}`,
          input: "",
          context: { files: [file] },
          limits: DEFAULT_READONLY_LIMITS,
          toolPolicy: DEFAULT_READONLY_TOOL_POLICY,
          modelPolicy: DEFAULT_READONLY_MODEL_POLICY,
        }),
      );
    }

    const segments = text.split(/\n{2,}|；|;|\|/).map((s) => s.trim()).filter(Boolean);
    if (segments.length >= 2 && segments.length <= maxTasks) {
      return segments.slice(0, maxTasks).map((segment, i) =>
        normalizeDelegatedTask({
          id: randomUUID(),
          goal: segment,
          instructions: `完成子任务 ${i + 1}/${Math.min(segments.length, maxTasks)}：${segment}`,
          input: "",
          limits: DEFAULT_READONLY_LIMITS,
          toolPolicy: DEFAULT_READONLY_TOOL_POLICY,
          modelPolicy: DEFAULT_READONLY_MODEL_POLICY,
        }),
      );
    }

    return [
      normalizeDelegatedTask({
        id: randomUUID(),
        goal: text,
        instructions: text,
        input: "",
        limits: DEFAULT_READONLY_LIMITS,
        toolPolicy: DEFAULT_READONLY_TOOL_POLICY,
        modelPolicy: DEFAULT_READONLY_MODEL_POLICY,
      }),
    ];
  }
}

function extractFilePaths(text: string): string[] {
  const matches = text.match(
    /[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|json|md|yaml|yml|toml|sql|sh|vue|svelte)\b/gi,
  );
  if (!matches) return [];
  return [...new Set(matches)];
}

export const defaultTaskSplitter = new TaskSplitter();
