import path from "node:path";

import type { TraceLogger } from "../trace/TraceLogger.js";
import type { ShellPolicy } from "../policy/ShellPolicy.js";
import type { NetworkPolicy } from "../policy/NetworkPolicy.js";
import {
  applyPatchTool,
  backupFileTool,
  diffFileTool,
  listFilesTool,
  readFileTool,
  rollbackChangeTool,
  searchTextTool,
  writeFileTool,
} from "./fileTools.js";
import { gitDiffTool, gitStatusTool } from "./gitTools.js";
import {
  contextPackTool,
  locateRelevantFilesTool,
  projectIndexUpdateTool,
  projectScanTool,
  symbolSearchTool,
} from "./locationTools.js";
import { shellRunTool } from "./shellTool.js";
import { dispatchSubagentTool } from "./subagentTool.js";
import { ToolStorage } from "./storage/ToolStorage.js";
import { ToolRegistry } from "./ToolRegistry.js";
import { StaticToolProvider } from "./ToolProvider.js";
import type { ProcessSandbox } from "../sandbox/ProcessSandbox.js";

export * from "./types.js";
export { resolveInsideWorkspace, resolveInsideWorkspaceAsync, assertInsideWorkspace } from "./pathSafe.js";
export { checkCommandRisk, type RiskLevel, type RiskVerdict } from "./risk.js";
export {
  readFileTool,
  listFilesTool,
  searchTextTool,
  writeFileTool,
  applyPatchTool,
  diffFileTool,
  backupFileTool,
  rollbackChangeTool,
} from "./fileTools.js";
export { gitStatusTool, gitDiffTool } from "./gitTools.js";
export { projectScanTool, projectIndexUpdateTool, locateRelevantFilesTool, contextPackTool, symbolSearchTool } from "./locationTools.js";
export { shellRunTool } from "./shellTool.js";
export { dispatchSubagentTool, DISPATCH_SUBAGENT_TOOL_NAME } from "./subagentTool.js";
export { ToolStorage } from "./storage/ToolStorage.js";
export { ToolRegistry, type RegistryRunContext } from "./ToolRegistry.js";
export { StaticToolProvider, type ToolProvider } from "./ToolProvider.js";
export {
  createMockRegistry,
  createMockTool,
  type CreateMockRegistryOptions,
  type MockTool,
  type MockToolCall,
  type MockToolOptions,
} from "./mockTools.js";

/** 第一阶段内置工具（规范 v1.0）。 */
export const BUILTIN_TOOLS = [
  readFileTool,
  listFilesTool,
  searchTextTool,
  writeFileTool,
  applyPatchTool,
  diffFileTool,
  backupFileTool,
  rollbackChangeTool,
  shellRunTool,
  gitStatusTool,
  gitDiffTool,
  projectScanTool,
  projectIndexUpdateTool,
  locateRelevantFilesTool,
  contextPackTool,
  symbolSearchTool,
  dispatchSubagentTool,
];

export interface CreateRegistryOptions {
  trace?: TraceLogger;
  /** 数据目录（含 agent_data/）；传入后启用备份、变更追踪与 tool_logs。 */
  dataDir?: string;
  shellPolicy?: ShellPolicy;
  networkPolicy?: NetworkPolicy;
  /** Required for tools that start shell or Git processes. */
  processSandbox?: ProcessSandbox;
}

/** 创建包含全部内置工具的注册表。 */
export function createDefaultRegistry(opts?: CreateRegistryOptions | TraceLogger): ToolRegistry {
  const options: CreateRegistryOptions =
    opts && typeof opts === "object" && ("dataDir" in opts || "trace" in opts || "shellPolicy" in opts || "networkPolicy" in opts || "processSandbox" in opts)
      ? opts
      : { trace: opts as TraceLogger | undefined };
  const storage = options.dataDir ? new ToolStorage(options.dataDir) : undefined;
  const registry = new ToolRegistry(options.trace, storage);
  if (options.processSandbox) {
    registry.setDefaultContext({ processSandbox: options.processSandbox });
  }
  if (options.shellPolicy || options.networkPolicy) {
    registry.setDefaultContext({
      shellPolicy: options.shellPolicy,
      networkPolicy: options.networkPolicy,
    });
  }
  registry.registerProvider(new StaticToolProvider("builtin", BUILTIN_TOOLS));
  return registry;
}

/** 默认 data 目录（相对 Ariadne Runtime 根）。 */
export function defaultDataDir(projectRoot: string): string {
  return path.join(projectRoot, "data");
}
