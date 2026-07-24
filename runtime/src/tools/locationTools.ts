/** @deprecated 实现已拆分至 tools/location/；本文件保留向后兼容 re-export。 */
export {
  analyzeTaskQuery,
  collectProjectFiles,
  projectScanTool,
  projectIndexUpdateTool,
  locateRelevantFilesTool,
  symbolSearchTool,
  contextPackTool,
} from "./location/index.js";
export type { LocateBudget, SearchPlan, ProjectFileMeta } from "./location/index.js";
