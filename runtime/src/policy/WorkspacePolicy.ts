import {
  resolveInsideWorkspace,
  resolveInsideWorkspaceAsync,
  assertInsideWorkspace,
  shouldIgnoreDir,
} from "../tools/pathSafe.js";

export {
  resolveInsideWorkspace,
  resolveInsideWorkspaceAsync,
  assertInsideWorkspace,
  shouldIgnoreDir,
};

/** 校验路径在工作区内；失败抛错。 */
export function assertInsideWorkspaceOrThrow(workspaceRoot: string, target: string): string {
  return resolveInsideWorkspace(workspaceRoot, target);
}
