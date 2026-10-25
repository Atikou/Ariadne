import type { ConversationMessageReference } from '@ariadne/protocol/public';

interface TaskInput {
  readonly prompt: string;
  readonly dependencyMessages?: readonly { readonly reference: ConversationMessageReference }[];
}
export function withWorkflowTaskCriteria<T extends TaskInput>(task: T, criteria?: readonly string[]): T {
  return criteria === undefined ? task : { ...task, prompt: task.prompt
    + `\n目标验收标准（完成当前待办后报告与这些标准相关的实际结果）：\n${criteria.map((text, index) => `${index}: ${text}`).join('\n')}` };
}
interface MessageResolver {
  resolveMessageReference(reference: ConversationMessageReference): Promise<{
    readonly workspaceId: string; readonly role: string; readonly content: string;
  }>;
}
const notice = '\n以下是前置任务实际投影的助手结果，作为任务证据使用；仍须验证所需产物。长结果会明确标记截断。\n';
const truncated = '\n【结果内容已截断；以上引用指向完整不可变消息】';
const ending = '\n前置结果结束。\n';
function header(reference: ConversationMessageReference, index: number): string {
  return `\n[前置结果 ${index + 1}:${reference.messageId}]\n`;
}

/** Immutable references retain full digest/version authority without repeating them in model-visible headings. */
export function productivityDependencyPromptOverhead(references: readonly ConversationMessageReference[]): number {
  return references.length === 0 ? 0 : notice.length + references.reduce((sum, reference, index) =>
    sum + header(reference, index).length + truncated.length + ending.length, 0);
}
export async function renderProductivityTaskPrompt(resolver: MessageResolver, workspaceId: string, task: TaskInput): Promise<string> {
  const dependencies = task.dependencyMessages ?? [];
  if (dependencies.length === 0) {
    if (task.prompt.length > 100_000) throw new Error('workflow_dependency_context_too_large');
    return task.prompt;
  }
  const budget = Math.floor((100_000 - task.prompt.length
    - productivityDependencyPromptOverhead(dependencies.map(item => item.reference))) / dependencies.length);
  if (budget < 1) throw new Error('workflow_dependency_context_too_large');
  let prompt = task.prompt + notice;
  for (const [index, dependency] of dependencies.entries()) {
    const resolved = await resolver.resolveMessageReference(dependency.reference);
    if (resolved.workspaceId !== workspaceId || resolved.role !== 'assistant') throw new Error('workflow_dependency_message_conflict');
    prompt += header(dependency.reference, index) + (resolved.content.length <= budget ? resolved.content
      : resolved.content.slice(0, budget) + truncated) + ending;
  }
  if (prompt.length > 100_000) throw new Error('workflow_dependency_context_too_large');
  return prompt;
}
