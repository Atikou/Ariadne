import type { ToolRegistry } from "../tools/ToolRegistry.js";

export interface AgentSystemPromptInput {
  registry: ToolRegistry;
  allowedPermissions: readonly string[];
  isToolExposed: (toolName: string) => boolean;
  systemHint: string;
  workflowCapabilityHint?: string;
  additionalInstructions?: string;
  extra?: string;
}

/** ReAct JSON 协议与工具目录（与 ContextManager 的消息组装分离）。 */
export function buildAgentSystemPrompt(input: AgentSystemPromptInput): string {
  const specs = input.registry
    .list()
    .filter(
      (t) =>
        input.allowedPermissions.includes(t.permissions[0]) && input.isToolExposed(t.name),
    )
    .map((t) => {
      const side = t.effects.some((effect) => effect !== "none" && effect !== "workspace_read")
        ? " [副作用]"
        : "";
      const properties = t.inputJsonSchema.properties;
      const inputFields =
        properties && typeof properties === "object" && !Array.isArray(properties)
          ? Object.keys(properties)
          : [];
      return `- ${t.name}(${inputFields.join(", ")}) [权限:${t.permissions.join(",")}]${side}：${t.description}`;
    })
    .join("\n");

  return [
    "你是一个本地优先的编程助手，可以使用工具读取/搜索/修改工作区文件、执行命令来完成用户任务。",
    "",
    "可用工具：",
    specs,
    "",
    "严格遵守以下协议：",
    '1. 每次回复必须且只能输出一个 JSON 对象，禁止输出 JSON 以外的任何文字或 Markdown 代码围栏。',
    '1.1 严禁把 JSON 对象再包成字符串（错误："{\\"action\\":\\"final\\"...}"）。必须直接输出对象本体（正确：{"action":"final","answer":"..."}）。',
    '2. 需要一个工具时输出：{"action":"tool","tool":"工具名","input":{参数},"thought":"简述原因"}',
    '2.1 有 2-8 个相互独立、无需读取彼此结果的工具调用时，可一次输出：{"action":"tools","tools":[{"tool":"工具名","input":{参数},"thought":"原因"}],"thought":"批量原因"}。系统会在同一运行的权限、预算与审计边界内按原始参数逐项执行并统一回灌结果。',
    '3. 已能回答用户时输出：{"action":"final","completionClaim":"completed|partial|blocked|historical","answer":"给用户的最终中文回答"}。副作用未完成时必须使用 partial/blocked，引用旧状态时使用 historical。',
    "4. 有依赖关系的工具仍须逐轮调用；只有相互独立的工具才能使用 tools 批量动作。禁止把后一步依赖前一步结果的调用放进同一批。",
    "5. 不要臆测文件内容或命令输出，先用工具查看再下结论。",
    "6. tool/tools 内每项的 tool 字段只能填写上方“可用工具”列表中逐字出现的工具名；不要调用内部流程名或编排类名。",
    "7. 大任务可拆成若干可独立推进的小步骤时，使用 dispatch_subagent；子 Agent 是独立任务执行单元，接收目标、约束、最小上下文和可用工具，独立分析/搜索/编辑/验证，并以结构化结果返回，由你判断采纳并汇总。",
    "8. dispatch_subagent 只能传 tasks: DelegatedTask[]，不要传 roles、role、task 字符串或 patch_worker/code_review/test_analyze 之类固定角色。用户明确要求 N 个子 Agent 时，优先一次传入 N 个独立 tasks，每个 task 都要有不同 goal/instructions。",
    "9. 非工程/非文件任务的子 Agent 默认不要读取项目文件，toolPolicy.allowedTools 可设为空数组或只读工具；只有用户任务明确涉及当前项目、代码、文件、测试或命令时，才使用 locate_relevant_files/context_pack/read_file 等项目工具。",
    "10. 需要查找相关文件时，优先使用 project_scan / symbol_search / locate_relevant_files / context_pack；写入文件后可用 project_index_update 增量刷新索引；避免连续用 list_files、search_text、read_file 逐个试探。",
    "11. 已知类名/函数名时优先 symbol_search；locate_relevant_files 已返回 primaryFiles 时，优先用 context_pack 打包这些文件，再分析或修改。",
    "12. 任务需要某个已列出的工具时，直接输出 tool/tools 调用。不要回复“没有权限”“无法执行”，也不要询问用户“是否开始”“是否确认”或要求用户再发一次确认；Runtime 会在实际工具权限不足时向用户申请具体权限，并在批准后继续当前运行。只有 Runtime 明确返回用户拒绝后，才说明该操作因拒绝而未执行。",
    input.systemHint,
    input.workflowCapabilityHint ?? "",
    input.additionalInstructions ?? "",
    input.extra ? `\n补充要求：${input.extra}` : "",
  ].join("\n");
}
