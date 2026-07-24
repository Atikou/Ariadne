import { finalizePlan } from "../agent/taskGraph.js";
import type { Plan, PlanStep } from "../agent/types.js";
import type { ToolPermission } from "../core/permissions.js";
import { requiresConfirmation } from "../core/permissions.js";
import { buildTodoDependsOn } from "./planDagBuilder.js";
import { PlanValidationError, type UserVisiblePlan, type UserVisibleTodo } from "./types.js";

export interface CompileUserVisiblePlanInput {
  userVisiblePlan: UserVisiblePlan;
  confirmedTodoIds: string[];
}

export class PlanCompiler {
  compile(input: CompileUserVisiblePlanInput): Plan {
    const selected = selectTodos(input.userVisiblePlan.todos, input.confirmedTodoIds);
    if (selected.length === 0) {
      throw new PlanValidationError(
        "INVALID_SCHEMA",
        "confirmedTodoIds 至少需要命中一条 UserVisibleTodo",
      );
    }

    const steps: PlanStep[] = selected.map((todo, index) => {
      const requiredPermissions = inferPermissions(todo);
      return {
        id: todo.id,
        title: todo.title,
        objective: todo.goal,
        description: todo.implementationIdea,
        requiredPermissions,
        needsConfirmation:
          todo.requiresUserConfirmation ||
          todo.riskLevel !== "low" ||
          requiresConfirmation(requiredPermissions),
        acceptance: todo.acceptanceCriteria.join("；"),
        dependsOn: buildTodoDependsOn(selected, todo),
        requiredContext: todo.relatedFiles ?? [],
        availableTools: inferAvailableTools(requiredPermissions),
        expectedArtifacts: todo.acceptanceCriteria,
        priority: priorityNumber(todo.priority, index),
        status: "pending",
      };
    });

    return finalizePlan({
      goal: input.userVisiblePlan.title,
      scope: {
        inScope: selected.map((t) => t.title),
        outOfScope: ["未确认的 Todo", "UserVisiblePlan Markdown 原文直接执行"],
      },
      inputs: [`UserVisiblePlan:${input.userVisiblePlan.id}`],
      outputs: ["待审批 ExecutableTaskPlan 草案"],
      acceptanceCriteria: selected.flatMap((t) => t.acceptanceCriteria),
      risks: input.userVisiblePlan.risks.map((r) => r.title),
      dependencies: ["用户确认 Todo 范围", "PlanValidator 校验", "PlanStore 持久化"],
      steps,
    });
  }
}

function selectTodos(todos: UserVisibleTodo[], ids: string[]): UserVisibleTodo[] {
  const selectedIds = new Set(ids);
  return todos.filter((todo) => selectedIds.has(todo.id));
}

function inferPermissions(todo: UserVisibleTodo): ToolPermission[] {
  const text = `${todo.title} ${todo.goal} ${todo.implementationIdea ?? ""}`.toLowerCase();
  const needsShell = /\b(npm|npx|yarn|pnpm|node\s|shell|运行|执行命令|安装)\b/.test(text);
  const needsWrite =
    /\b(写|修改|实现|补丁|patch|覆盖|新增|创建|新建|write_file|apply_patch)\b/.test(text) ||
    todo.riskLevel === "medium" ||
    todo.riskLevel === "high";

  const perms = new Set<ToolPermission>(["read"]);
  if (todo.riskLevel === "high" || needsShell) perms.add("shell");
  if (todo.riskLevel === "medium" || todo.riskLevel === "high" || needsWrite) perms.add("write");

  if (!todo.allowAutoImplement && todo.riskLevel === "low" && !needsShell && !needsWrite) {
    return ["read"];
  }
  return [...perms];
}

function priorityNumber(priority: UserVisibleTodo["priority"], index: number): number {
  const base = { P0: 0, P1: 100, P2: 200, P3: 300 }[priority];
  return base + index;
}

function inferAvailableTools(permissions: ToolPermission[]): string[] {
  const tools = new Set<string>(["read_file", "search_text", "list_files"]);
  if (permissions.includes("write")) {
    tools.add("apply_patch");
    tools.add("write_file");
    tools.add("diff_file");
  }
  if (permissions.includes("shell")) tools.add("shell_run");
  if (permissions.includes("read")) {
    tools.add("git_diff");
    tools.add("locate_relevant_files");
  }
  return [...tools];
}
