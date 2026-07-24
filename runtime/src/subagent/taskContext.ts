import type { ToolPermission } from "../core/permissions.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { ToolExecutionGateway } from "../agent/ToolExecutionGateway.js";
import { defaultWorkflowRouter } from "../agent/WorkflowRouter.js";

/** 从任务描述中提取疑似工作区相对路径（如 src/agent/AgentLoop.ts）。 */
export function extractFilePaths(task: string): string[] {
  const re = /(?:^|[\s,，;；:：「『"'(（])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt))/gi;
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(task)) !== null) {
    found.add(m[1]!.replace(/\\/g, "/"));
  }
  if (found.size === 0) {
    const loose = task.match(/(?:^|[\s/])((?:src|tests|config|public)[/\w.-]+\.(?:ts|tsx|js|jsx|json|md|txt))/gi);
    for (const raw of loose ?? []) {
      found.add(raw.trim().replace(/\\/g, "/"));
    }
  }
  const standaloneRe =
    /(?:^|[\s,，;；:：「『"'(（])((?:package|README|tsconfig)[\w.-]*\.(?:json|md|txt)|[\w.-]+\.(?:json|md|txt))(?=$|[\s,，)）」』"'])/gi;
  let sm: RegExpExecArray | null;
  while ((sm = standaloneRe.exec(task)) !== null) {
    const name = sm[1]!.replace(/\\/g, "/");
    if (!name.includes("/")) found.add(name);
  }
  return [...found];
}

/** 预读块中是否至少有一个文件成功（非「预读失败」）。 */
export function hasSuccessfulPreload(preloaded: string): boolean {
  if (!preloaded.trim()) return false;
  const parts = preloaded.split("\n\n").slice(1);
  return parts.some((p) => p.includes("【") && !p.includes("预读失败"));
}

/**
 * 若任务提到具体文件，子 Agent 启动前预读并注入上下文，减少迭代消耗。
 */
export async function preloadReferencedFiles(
  task: string,
  registry: ToolRegistry,
  workspaceRoot: string,
  maxFiles = 2,
): Promise<string> {
  const paths = extractFilePaths(task).slice(0, maxFiles);
  if (paths.length === 0) return "";

  const blocks: string[] = [
    "以下文件已预读（优先基于这些内容审查，勿重复 read_file 同一文件，除非预读失败）：",
  ];

  const gateway = new ToolExecutionGateway(registry);

  for (const filePath of paths) {
    const result = await gateway.run({
      toolName: "read_file",
      input: { path: filePath },
      source: "preflight",
      budgetBucket: "preflight",
      workspaceRoot,
      allowedPermissions: ["read"],
      intent: "answer",
      permissionPolicy: "readOnly",
      mode: "chat",
      workflowRoute: defaultWorkflowRouter.routeIntent("answer"),
    });
    if (!result.ok) {
      blocks.push(`【${filePath}】预读失败：${result.error}`);
      continue;
    }
    const out = result.output as { path: string; content: string; truncated?: boolean };
    const tail = out.truncated ? "\n（内容已截断）" : "";
    blocks.push(`【${out.path}】\n${out.content}${tail}`);
  }

  return blocks.join("\n\n");
}
