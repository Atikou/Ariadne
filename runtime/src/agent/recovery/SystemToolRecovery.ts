import type { AgentToolStep } from "../toolStep.js";

import { isObservationFailureStep, isSuccessfulToolStep } from "../toolStepOutcome.js";



export interface SystemRecoveryAction {

  tool: string;

  input: Record<string, unknown>;

  reason: string;

}



export interface SystemRecoveryPlan {

  actions: SystemRecoveryAction[];

  preamble: string;

}



const SCAN_TOOLS = new Set(["project_scan", "locate_relevant_files", "symbol_search"]);



/** 工具失败后由系统选择 fallback，不消耗主 model turn。 */

export function planSystemRecovery(step: AgentToolStep, goal: string): SystemRecoveryPlan | undefined {

  if (step.ok || step.blocked || step.cached) return undefined;



  if (step.tool === "project_scan") {

    const root = inferProjectRoot(goal, step.input);

    return {

      preamble: "（系统）project_scan 未得到有效项目信息，已自动改用 list_files 列出目录，请勿重复相同 project_scan。",

      actions: [

        {

          tool: "list_files",

          input: { root, recursive: false, maxDepth: 2, limit: 40 },

          reason: "project_scan 失败后的系统 fallback：列出目录结构",

        },

      ],

    };

  }



  if (step.tool === "list_files" && (step.outcomeKind === "not_found" || step.outcomeKind === "no_results")) {

    const root = readRoot(step.input);

    if (root !== ".") {

      return {

        preamble: "（系统）list_files 目标目录无效，已自动从工作区根列出目录。",

        actions: [

          {

            tool: "list_files",

            input: { root: ".", recursive: false, maxDepth: 2, limit: 40 },

            reason: "list_files not_found 后的系统 fallback",

          },

        ],

      };

    }

  }



  if (

    SCAN_TOOLS.has(step.tool) &&

    (step.outcomeClass === "execution_error" || isObservationFailureStep(step))

  ) {

    return {

      preamble: `（系统）${step.tool} 未成功，已自动改用 list_files 探索工作区；请勿重复相同调用。`,

      actions: [

        {

          tool: "list_files",

          input: { root: ".", recursive: false, maxDepth: 2, limit: 40 },

          reason: `${step.tool} 失败后的系统 fallback`,

        },

      ],

    };

  }



  if (step.tool === "read_file" && step.outcomeKind === "not_found") {

    const path = readPath(step.input);

    const parent = parentDir(path);

    return {

      preamble: "（系统）read_file 目标不存在，已自动列出父目录。",

      actions: [

        {

          tool: "list_files",

          input: { root: parent, recursive: false, maxDepth: 1, limit: 30 },

          reason: "read_file not_found 后的系统 fallback",

        },

      ],

    };

  }



  return undefined;

}



export function renderCacheReuseContext(tool: string, input: Record<string, unknown>): string {

  const path = readPath(input);

  const root = readRoot(input);

  const target = path ?? root ?? tool;

  return [

    "（系统）本 run 内已读取过相同只读工具请求，文件/目录未修改，直接复用缓存结果。",

    `工具：${tool}，目标：${target}`,

    "请勿重复相同 read_file / list_files / project_scan 调用；若需最新内容，请先写入或换用其它路径。",

  ].join("\n");

}



function inferProjectRoot(goal: string, input: unknown): string {

  const record = (input ?? {}) as Record<string, unknown>;

  const root = typeof record.root === "string" ? record.root : "";

  if (root && !root.startsWith("/") && !/^[A-Za-z]:/.test(root)) return root;

  const fromGoal = goal.match(/(?:^|\s)([A-Za-z][\w-]*)/)?.[1];

  if (fromGoal) return fromGoal;

  return ".";

}



function readPath(input: unknown): string {

  const record = (input ?? {}) as Record<string, unknown>;

  const path = record.path ?? record.file ?? record.target;

  return typeof path === "string" ? path.replace(/\\/g, "/") : ".";

}



function readRoot(input: unknown): string {

  const record = (input ?? {}) as Record<string, unknown>;

  return typeof record.root === "string" ? record.root.replace(/\\/g, "/") : ".";

}



function parentDir(relPath: string): string {

  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);

  parts.pop();

  return parts.length ? parts.join("/") : ".";

}



export function shouldInvalidateCache(step: AgentToolStep): boolean {

  return (

    isSuccessfulToolStep(step) &&

    (step.tool === "write_file" || step.tool === "apply_patch")

  );

}



export function cacheInvalidationPath(step: AgentToolStep): string | undefined {

  if (!shouldInvalidateCache(step)) return undefined;

  const input = (step.input ?? {}) as Record<string, unknown>;

  const path = input.path ?? input.file;

  return typeof path === "string" ? path.replace(/\\/g, "/") : undefined;

}
