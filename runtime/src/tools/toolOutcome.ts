/**
 * 工具结果语义分层（全工具统一协议）。
 *
 * - execution_error：工具未正常执行（校验失败、崩溃、超时、策略拒绝等）
 * - observation_failure：工具已执行，但观察到的目标状态不满足（not_found、no_results、command_failed…）
 * - observation_success：工具已执行且结果符合预期
 */

export type ToolOutcomeClass = "execution_error" | "observation_failure" | "observation_success";

export type ToolObservationFailureKind =
  | "not_found"
  | "not_a_file"
  | "no_results"
  | "empty_result"
  | "no_project_info"
  | "command_failed"
  | "command_not_found";

export type ToolExecutionErrorKind =
  | "invalid_input"
  | "unknown_tool"
  | "permission_denied"
  | "timeout"
  | "policy_blocked"
  | "tool_crash";

export type ToolObservationSuccessKind = "ok";

export type ToolOutcomeKind =
  | ToolObservationSuccessKind
  | ToolObservationFailureKind
  | ToolExecutionErrorKind;

export interface SuggestedToolAction {
  tool: string;
  reason: string;
  input?: Record<string, unknown>;
}

export interface ToolOutcome {
  class: ToolOutcomeClass;
  kind: ToolOutcomeKind;
  message: string;
  recoverable: boolean;
  /** 是否需要用户授权、安装依赖或确认后才能继续 */
  requiresUserAction?: boolean;
  path?: string;
  command?: string;
  exitCode?: number;
  suggestedNextActions?: SuggestedToolAction[];
}

export function observationSuccess(message = "ok"): ToolOutcome {
  return { class: "observation_success", kind: "ok", message, recoverable: false };
}

export function observationFailure(
  kind: ToolObservationFailureKind,
  message: string,
  extra?: Partial<Omit<ToolOutcome, "class" | "kind" | "message">>,
): ToolOutcome {
  return {
    class: "observation_failure",
    kind,
    message,
    recoverable: extra?.recoverable ?? true,
    path: extra?.path,
    command: extra?.command,
    exitCode: extra?.exitCode,
    suggestedNextActions: extra?.suggestedNextActions,
  };
}

export function executionError(
  kind: ToolExecutionErrorKind,
  message: string,
  extra?: Partial<Omit<ToolOutcome, "class" | "kind" | "message">> & { requiresUserAction?: boolean },
): ToolOutcome {
  return {
    class: "execution_error",
    kind,
    message,
    recoverable: extra?.recoverable ?? false,
    requiresUserAction: extra?.requiresUserAction,
    path: extra?.path,
    command: extra?.command,
    exitCode: extra?.exitCode,
    suggestedNextActions: extra?.suggestedNextActions,
  };
}

export function isObservationFailure(outcome: Pick<ToolOutcome, "class">): boolean {
  return outcome.class === "observation_failure";
}

export function isExecutionError(outcome: Pick<ToolOutcome, "class">): boolean {
  return outcome.class === "execution_error";
}

export function isObservationSuccess(outcome: Pick<ToolOutcome, "class">): boolean {
  return outcome.class === "observation_success";
}

export function parentDir(relPath: string): string {
  const parts = relPath.replace(/\\/g, "/").split("/").filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") : ".";
}

export function buildNotFoundOutcome(path: string): ToolOutcome {
  const normalized = path.replace(/\\/g, "/");
  const parent = parentDir(normalized);
  const fileName = normalized.split("/").pop() ?? normalized;
  const pkgPath = parent === "." ? "package.json" : `${parent}/package.json`;
  const suggestedNextActions: SuggestedToolAction[] = [
    { tool: "list_files", reason: "确认父目录结构", input: { root: parent } },
    { tool: "search_text", reason: "搜索同名或相关文件", input: { query: fileName } },
    { tool: "read_file", reason: "读取项目配置（若存在）", input: { path: pkgPath } },
  ];
  if (fileName === "index.html" || normalized.endsWith("/index.html")) {
    suggestedNextActions.push({
      tool: "write_file",
      reason: "若确认为 Vite 入口缺失，可创建 index.html",
      input: { path: normalized, content: "<!-- entry -->\n" },
    });
  }
  return observationFailure("not_found", `文件不存在：${normalized}`, {
    path: normalized,
    suggestedNextActions,
  });
}

export function buildListDirNotFoundOutcome(root: string): ToolOutcome {
  return observationFailure("not_found", `目录不存在：${root}`, {
    path: root.replace(/\\/g, "/"),
    suggestedNextActions: [
      { tool: "list_files", reason: "从工作区根列出目录", input: { root: "." } },
      { tool: "search_text", reason: "搜索目标目录名", input: { query: root.split("/").pop() ?? root } },
    ],
  });
}

export function buildNoResultsOutcome(query: string, root: string): ToolOutcome {
  return observationFailure("no_results", `未找到匹配「${query}」的搜索结果`, {
    suggestedNextActions: [
      { tool: "search_text", reason: "放宽关键词或关闭 regex", input: { query, root, regex: false } },
      { tool: "list_files", reason: "列出目录确认范围", input: { root } },
      { tool: "locate_relevant_files", reason: "用语义定位相关文件", input: { query } },
    ],
  });
}

export function buildCommandFailedOutcome(command: string, exitCode: number, stderr: string): ToolOutcome {
  return observationFailure("command_failed", `命令已执行但失败（exitCode=${exitCode}）`, {
    command,
    exitCode,
    suggestedNextActions: [
      { tool: "read_file", reason: "读取相关源文件定位错误", input: {} },
      { tool: "search_text", reason: "在日志/源码中搜索错误关键词", input: { query: "error" } },
    ],
  });
}

export function buildCommandNotFoundOutcome(command: string, exitCode: number, stderr: string): ToolOutcome {
  const detail = stderr.trim().slice(0, 120);
  return observationFailure("command_not_found", `命令无法启动或未找到：${command}${detail ? `（${detail}）` : ""}`, {
    command,
    exitCode,
    suggestedNextActions: [
      { tool: "read_file", reason: "检查 package.json scripts 与依赖", input: { path: "package.json" } },
      { tool: "shell_run", reason: "确认运行时/路径（如 where node / which npm）", input: { command: "node -v" } },
    ],
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Windows cmd 未找到命令时常为 exitCode=1 且 stderr 以带引号的命令名开头（GBK 文案可能乱码）。 */
function isCommandNotFoundSignal(
  command: string,
  stderr: string,
  stdout: string,
  exitCode: number,
): boolean {
  const combined = `${stderr}\n${stdout}`;
  if (
    /not found|不是内部或外部命令|command not found|无法将.*识别为|批处理文件|internal or external|not recognized|enoent/i.test(
      combined,
    )
  ) {
    return true;
  }
  if (exitCode === 127 || exitCode === 9009) return true;
  if (exitCode === 1 && command && !stdout.trim()) {
    const lead = stderr.trimStart();
    if (lead.startsWith(`'${command}'`) || lead.startsWith(`"${command}"`)) {
      return true;
    }
  }
  return false;
}

/** 从工具输出解析 outcome；工具可显式嵌入 `outcome` 字段。 */
export function resolveToolOutcome(tool: string, output: unknown): ToolOutcome {
  const record = asRecord(output);
  const embedded = asRecord(record?.outcome);
  if (embedded && typeof embedded.class === "string" && typeof embedded.kind === "string") {
    return embedded as unknown as ToolOutcome;
  }

  if (tool === "read_file" && record) {
    if (record.found === false) {
      const path = typeof record.path === "string" ? record.path : "unknown";
      if (record.outcome && typeof record.outcome === "object") return record.outcome as ToolOutcome;
      return buildNotFoundOutcome(path);
    }
    if (typeof record.path === "string" && typeof record.content === "string") {
      return observationSuccess(`已读取 ${record.path}`);
    }
  }

  if (tool === "search_text" && record) {
    const results = Array.isArray(record.results) ? record.results : [];
    const query = typeof record.query === "string" ? record.query : "";
    const root = typeof record.root === "string" ? record.root : ".";
    if (results.length === 0) {
      return buildNoResultsOutcome(query, root);
    }
    return observationSuccess(`搜索「${query}」命中 ${results.length} 条`);
  }

  if (tool === "list_files" && record) {
    const files = Array.isArray(record.files) ? record.files : [];
    const root = typeof record.root === "string" ? record.root : ".";
    if (record.found === false) {
      return buildListDirNotFoundOutcome(root);
    }
    if (files.length === 0 && !record.truncated) {
      return observationFailure("no_results", `目录「${root}」为空`, {
        path: root,
        suggestedNextActions: [
          { tool: "list_files", reason: "列出上级目录", input: { root: parentDir(root) } },
        ],
      });
    }
    return observationSuccess(`列出 ${files.length} 个条目（root=${root}）`);
  }

  if (tool === "shell_run" && record) {
    if (record.spawnFailed === true) {
      return executionError("tool_crash", "Shell 执行器无法启动命令", { recoverable: false });
    }
    const command = typeof record.command === "string" ? record.command : "";
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    const stdout = typeof record.stdout === "string" ? record.stdout : "";
    const exitCode = typeof record.exitCode === "number" ? record.exitCode : 0;
    const timedOut = record.timedOut === true;
    if (timedOut) {
      return executionError("timeout", "命令执行超时");
    }
    if (exitCode === 0) {
      return observationSuccess(`命令执行成功：${command}`);
    }
    if (isCommandNotFoundSignal(command, stderr, stdout, exitCode)) {
      return buildCommandNotFoundOutcome(command, exitCode, stderr || stdout);
    }
    return buildCommandFailedOutcome(command, exitCode, stderr);
  }

  if (tool === "project_scan" && record) {
    const scanned = typeof record.scannedFiles === "number" ? record.scannedFiles : 0;
    const importantFiles = Array.isArray(record.importantFiles) ? record.importantFiles : [];
    const sourceRoots = Array.isArray(record.sourceRoots) ? record.sourceRoots : [];
    const configFiles = Array.isArray(record.configFiles) ? record.configFiles : [];
    const scripts = asRecord(record.scripts);
    const projectType = typeof record.projectType === "string" ? record.projectType : "unknown";
    const root = typeof record.root === "string" ? record.root : ".";
    const hasProjectSignals =
      projectType !== "unknown" ||
      importantFiles.length > 0 ||
      sourceRoots.length > 0 ||
      configFiles.length > 0 ||
      Object.keys(scripts ?? {}).length > 0;
    if (!hasProjectSignals) {
      return observationFailure("no_project_info", `未扫描到有效项目信息（root=${root}）`, {
        path: root,
        suggestedNextActions: [
          { tool: "list_files", reason: "列出工作区目录", input: { root: ".", recursive: false, maxDepth: 2 } },
          { tool: "read_file", reason: "读取 package.json", input: { path: "package.json" } },
        ],
      });
    }
    if (scanned === 0) {
      return observationFailure("empty_result", "project_scan 返回空结果", {
        suggestedNextActions: [
          { tool: "list_files", reason: "改用目录列表探索", input: { root: "." } },
        ],
      });
    }
    return observationSuccess(`已扫描 ${scanned} 个文件`);
  }

  if (tool === "locate_relevant_files" && record) {
    const primary = Array.isArray(record.primaryFiles) ? record.primaryFiles : [];
    const candidates = Array.isArray(record.candidateFiles) ? record.candidateFiles : [];
    if (primary.length === 0 && candidates.length === 0) {
      const plan = asRecord(record.searchPlan);
      const goal = typeof plan?.goal === "string" ? plan.goal : "";
      return observationFailure("no_results", `未定位到相关文件${goal ? `（${goal}）` : ""}`, {
        suggestedNextActions: [
          { tool: "project_scan", reason: "扫描项目结构与入口" },
          { tool: "search_text", reason: "全文搜索关键词", input: { query: goal || "entry", root: "." } },
        ],
      });
    }
    return observationSuccess(`定位到 ${primary.length} 个主文件、${candidates.length} 个候选`);
  }

  if (tool === "symbol_search" && record) {
    const symbols = Array.isArray(record.symbols) ? record.symbols : [];
    const queries = Array.isArray(record.queries) ? record.queries.join(", ") : "";
    if (symbols.length === 0) {
      return buildNoResultsOutcome(queries || "symbol", ".");
    }
    return observationSuccess(`符号搜索命中 ${symbols.length} 条`);
  }

  if ((tool === "write_file" || tool === "apply_patch") && record) {
    const filePath = typeof record.path === "string" ? record.path : undefined;
    const changeId = typeof record.changeId === "string" ? record.changeId : undefined;
    if (filePath && changeId) {
      const isNew = record.isNew === true;
      return {
        ...observationSuccess(
          tool === "write_file"
            ? isNew
              ? `已创建 ${filePath}`
              : `已更新 ${filePath}`
            : `已补丁修改 ${filePath}`,
        ),
        path: filePath,
      };
    }
  }

  if (tool === "context_pack" && record) {
    const files = Array.isArray(record.files) ? record.files : [];
    const skipped = Array.isArray(record.skippedFiles) ? record.skippedFiles : [];
    if (files.length === 0) {
      return observationFailure(
        "no_results",
        skipped.length ? `请求的 ${skipped.length} 个文件均无法读取` : "未打包到任何文件",
        {
          suggestedNextActions: [
            { tool: "locate_relevant_files", reason: "重新定位相关文件" },
            { tool: "list_files", reason: "列出目录确认路径", input: { root: "." } },
          ],
        },
      );
    }
    const partial = skipped.length > 0 ? `（跳过 ${skipped.length} 个）` : "";
    return observationSuccess(`已打包 ${files.length} 个文件${partial}`);
  }

  return observationSuccess();
}

export function attachOutcome<T extends Record<string, unknown>>(payload: T, outcome: ToolOutcome): T & { outcome: ToolOutcome } {
  return { ...payload, outcome };
}

/** @deprecated 使用 ToolOutcome */
export type ToolObservation = ToolOutcome;
/** @deprecated 使用 ToolOutcomeKind */
export type ToolObservationKind = ToolOutcomeKind;

export function extractToolOutcome(output: unknown): ToolOutcome | undefined {
  const record = asRecord(output);
  const embedded = asRecord(record?.outcome);
  if (embedded && typeof embedded.class === "string") return embedded as unknown as ToolOutcome;
  return undefined;
}

/** @deprecated 使用 resolveToolOutcome */
export function extractToolObservation(tool: string, output: unknown): ToolOutcome | undefined {
  const embedded = extractToolOutcome(output);
  if (embedded) return embedded;
  if (tool === "read_file" && asRecord(output)?.found === false) {
    const path = typeof asRecord(output)?.path === "string" ? (asRecord(output)!.path as string) : undefined;
    if (path) return buildNotFoundOutcome(path);
  }
  return undefined;
}

/** @deprecated 使用 isObservationFailure */
export function isNegativeObservation(outcome: ToolOutcome | undefined): boolean {
  return Boolean(outcome && isObservationFailure(outcome));
}

/** @deprecated */
export const buildReadFileNotFoundObservation = buildNotFoundOutcome;
