import { readFile, writeFile } from 'node:fs/promises';

const record = `
## T10 最终任务中心与终态提醒验收（2026-10-06）

任务 ID：T10；状态：完成。授权只读聚合、来源复合身份、三来源水位、稳定分页与筛选、关联分页、原版本导航、结果窗口、待确认卡片及完成／失败偏好均已接通原所有者。T04 的 Windows 物理点击／历史消失／冷激活／活跃游戏验收保持未完成，不将 native shown 回执写成物理点击。任务中心不建立执行状态或重复通知服务。

完整原生门 electron-t10-durable-decision-evidence-full passed=true、fatalError=null、consoleErrors=[]；保留 70 请求／66 响应／4 预期中止、五次 Runtime 强杀、Main 重启和超大 Run 恢复。实际来源目录 33 项、五类来源、两页，三来源水位 ready；精确原 Core v12／不可变结果消息、过期拒绝、会话范围与返回筛选／位置通过。原 permission 和 user_question 未结算时的真实 Core／Decision 版本、原卡片可见与焦点通过；1000／1600 CSS 像素所属容器布局与截图已查看。此目录规模与先前独立 Source 门的 53 项分别记录，不混用。外部 HTTPS Provider 是确定性验收夹具，不代表真实用户模型质量。

electron-t10-native-completed-failed 使用原 Main／Runtime／SQLite 和原 Provider/Core 链路，四个 pending Decision native 回执、实际 Runtime 强杀／同版本去重／四决策结算、权限副作用和批准计划完成均通过。权限及两个计划卡片精确聚焦通过。实际 completed v7 和 failed v3 收到 Windows native shown 回执；失败由原引擎拒绝夹具的空白模型输出产生，不直接写失败数据库。electron-t10-terminal-main-reopen-settled 在同一隔离数据上从 Main PID 169720 重开至 163888，核验三 completed／一 failed 的原 Core 版本，保持两类偏好开启时间及全部送达账本不变；后台观察 35000 ms 后没有新增展示尝试。该门是实际干净 Main 重开，不冒充物理强杀或系统点击。

最终类型／生产构建 t10-native-restart-single-refresh-build.log、架构 t10-terminal-reminder-final-architecture.log 通过；完整 Renderer t10-final-full-renderer-ui.log 229 项通过。App 最近完整门 t10-original-decision-full-app-tests.log 为 99 文件／458 项，Runtime 最近完整门 t10-source-relations-full-runtime-tests.log 为 161 文件／1213 项，随后唯一 Runtime 产品变化 user_question 原导航归属通过 t10-question-original-navigation-runtime-tests.log 12 项并直接发射／更新 manifest。实际 SQLite 40 个授权关联／一错误 Core 归属拒绝、跨工作区、部分故障、取消、归档、变化版本、原 pending Decision、稳定快照和迟到选择均在各级所有者测试中验证。新增实际 native 夹具及 Main 重开观察器不改变产品领域逻辑。未重复完整 Runtime/App 门冒充新增真实模型覆盖。

历史失败保留：electron-t10-original-decisions-full 的取消驱动未恢复父会话；修正原驱动导航范围后，electron-t10-restored-parent-full 因 question 证据仅保存在会被 reload 清空的 Renderer 全局而失败，现通过首次 Main observation 保留实际原验证结果。Main 重开首轮在来源尚 building 时过早断言；第二轮每次 refresh 重新触发构建而超时，现首次刷新后只观察已发起构建，不提高原超时或放宽 Core／回执比较。三轮重开各自输出独立保留。提醒文字删除没有实际通知政策支持的锁屏承诺，实际规则仍为后台／游戏。

正式 ADR 0044、ui-architecture.md 和验证矩阵已收敛。T10 三项已勾选；T01／T04／T07 原独立外部门保持状态，整体未完成。下一操作：按 T11 原步骤审计精确存储清单、Main／Runtime 一致冻结边界、同机密钥材料及恢复切换，再接入用户界面并完成独立恢复演练。全部清单和最终验收完成、正式文档合并、最后删除 TODO 后直接关机，不询问，授权持续有效。
`;
let todo = await readFile('TODO.md', 'utf8');
todo = todo.replace('| T10 | 5.1：跨会话任务中心 | T02、T03、T04、T09 | 进行中 |', '| T10 | 5.1：跨会话任务中心 | T02、T03、T04、T09 | 完成 |');
const begin = todo.indexOf('### 5.1 跨会话任务中心'), end = todo.indexOf('### 5.2 数据管理与恢复');
if (begin < 0 || end < begin || todo.includes('## T10 最终任务中心与终态提醒验收')) throw new Error('T10 record already applied or section missing.');
todo = todo.slice(0, begin) + todo.slice(begin, end).replaceAll('- [ ]', '- [x]') + todo.slice(end) + record;
await writeFile('TODO.md', todo);
await writeFile('docs/remediation-verification.md', (await readFile('docs/remediation-verification.md', 'utf8')) + record);
const matrix = JSON.parse(await readFile('docs/verification-matrix.json', 'utf8'));
const row = matrix.rows.find(value => value.module === 'authorized-task-center-and-terminal-reminders');
row.status = 'verified'; row.realWindow = 'verified';
row.evidence.push('artifacts/todo-remediation/electron-t10-durable-decision-evidence-full/electron-runtime-smoke.json',
  'artifacts/todo-remediation/electron-t10-durable-decision-evidence-full/task-center-source-execution.json',
  'artifacts/todo-remediation/electron-t10-durable-decision-evidence-full/task-center-source-decisions.json',
  'artifacts/todo-remediation/electron-t10-durable-decision-evidence-full/desktop-restart-delivery.json',
  'artifacts/todo-remediation/electron-t10-native-completed-failed/decision-notification.json',
  'artifacts/todo-remediation/electron-t10-native-completed-failed/task-center-original-plan-focus.json',
  'artifacts/todo-remediation/electron-t10-terminal-main-reopen-settled/task-notification-main-restart.json',
  'artifacts/todo-remediation/t10-final-full-renderer-ui.log', 'artifacts/todo-remediation/t10-terminal-reminder-final-architecture.log',
  'artifacts/todo-remediation/t10-native-restart-single-refresh-build.log');
row.notes = 'Scoped T10 accepted: authorized original Source/relations/results/preferences, actual pending question/permission/plan focus, native completed/failed shown, same-directory Main reopen with four unchanged Core versions and delivery records. Full original 70/66/4 Electron/Main recovery and 229 UI interactions pass. Deterministic Provider only. T04 physical toast click/history/cold activation/game, other tasks and overall T16 remain incomplete.';
matrix.currentGate = { status: 'partial', reason: 't10_complete_t11_next_overall_incomplete',
  source: 'artifacts/todo-remediation/electron-t10-durable-decision-evidence-full/electron-runtime-smoke.json',
  notes: 'T10 scoped acceptance complete. T11–T16 and independent unresolved gates remain incomplete. Shutdown only after full completion.' };
await writeFile('docs/verification-matrix.json', JSON.stringify(matrix, null, 2) + '\n');
