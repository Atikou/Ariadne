import type { SideEffectKind } from "../completion/TaskCompletionContract.js";
import type { MessageContinuationSignals } from "./MessageSignalExtractor.js";

const SHELL_GOAL_RE =
  /安装[^，。；\n]{0,24}依赖|npm\s+install|yarn\s+install|pnpm\s+install|运行项目|启动项目|执行测试|跑测试|npm\s+run|yarn\s+run|pnpm\s+run|启动服务|运行命令|打包项目/i;
const WRITE_GOAL_RE =
  /修改|改写|增强|优化|写入|创建(?:文件|项目|目录|页面|代码)|生成文件|编写(?:文件|项目|页面|代码|HTML|CSS|JS)|apply|patch|实现方案|执行.*方案/i;
const READONLY_GOAL_RE =
  /是什么|什么是|介绍|解释|全局还是项目|审阅|审查|只读|不要改/i;

/**
 * 从 goal + 弱信号推断所需副作用。
 * 不做 intent/workflow 映射，仅输出 read/write/shell 需求供边界与裁决层使用。
 */
export function inferRequiredSideEffectsFromMessage(
  goal: string,
  signals?: Pick<
    MessageContinuationSignals,
    | "referencesProjectScope"
    | "expressesOutcomeDissatisfaction"
    | "requestsOutcomeChange"
    | "explicitReadonlyRequest"
  >,
): SideEffectKind[] {
  const fromGoal = inferRequiredSideEffectsFromGoal(goal);
  if (fromGoal.length > 0) return fromGoal;

  if (signals?.explicitReadonlyRequest) return [];

  if (
    signals?.referencesProjectScope &&
    (signals.expressesOutcomeDissatisfaction || signals.requestsOutcomeChange)
  ) {
    return ["write"];
  }

  return [];
}

/** 仅作为无 AI 时的入口边界弱信号；不得用于 FinalGuard 或直接选择 workflow。 */
export function inferRequiredSideEffectsFromGoal(goal: string): SideEffectKind[] {
  const text = goal.trim();
  if (!text) return [];
  if (READONLY_GOAL_RE.test(text) && !SHELL_GOAL_RE.test(text) && !WRITE_GOAL_RE.test(text)) {
    return [];
  }
  const required = new Set<SideEffectKind>();
  if (SHELL_GOAL_RE.test(text)) required.add("shell");
  if (WRITE_GOAL_RE.test(text) && !READONLY_GOAL_RE.test(text)) required.add("write");
  return [...required];
}
