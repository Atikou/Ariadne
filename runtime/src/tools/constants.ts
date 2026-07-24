/** 文件/搜索/list 默认忽略目录（相对路径段名）。 */
export const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".next",
  ".vite",
  ".lancedb",
  "agent_data",
]);

/** read_file 默认最大字节。 */
export const DEFAULT_READ_MAX_BYTES = 200 * 1024;

/** search_text 默认最大结果数。 */
export const DEFAULT_SEARCH_MAX_RESULTS = 100;

/** search_text 默认上下文行数。 */
export const DEFAULT_SEARCH_CONTEXT_LINES = 2;

/** list_files 默认最大条目。 */
export const DEFAULT_LIST_LIMIT = 500;

/** list_files 默认最大递归深度。 */
export const DEFAULT_LIST_MAX_DEPTH = 3;

/** shell_run 默认超时（毫秒）。 */
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;

/** shell_run 默认最大输出字节。 */
export const DEFAULT_SHELL_MAX_OUTPUT_BYTES = 200 * 1024;

/** git_diff 默认最大字节。 */
export const DEFAULT_GIT_DIFF_MAX_BYTES = 200 * 1024;
