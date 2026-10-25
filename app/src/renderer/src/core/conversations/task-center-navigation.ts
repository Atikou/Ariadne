import { PERSONAL_ASSISTANT_WORKSPACE_ID, type TaskCenterNavigationResult } from '@ariadne/protocol/public';
import type { ModuleServices } from '@renderer/core/modules/module-services-contract';

type NavigationServices = Pick<ModuleServices, 'conversationNavigation' | 'sessions' | 'runs' | 'decisions' | 'messages' | 'events'>;
/** Loads original features; no cancel, retry, approval, or replacement task is issued here. */
export async function openTaskCenterTarget(services: NavigationServices, response: TaskCenterNavigationResult): Promise<boolean> {
  const target = response.target;
  if (response.status !== 'ok' || target === null) return false;
  const initialWorkspace = services.conversationNavigation.getSelectedWorkspaceId();
  const initialSession = services.sessions.view.getSnapshot().selectedSessionId;
  const ownsSelection = () => services.sessions.view.getSnapshot().selectedSessionId === target.sessionId
    && services.conversationNavigation.getSelectedWorkspaceId() === (target.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID ? null : target.workspaceId);
  if (target.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID) services.conversationNavigation.selectAssistant();
  else {
    await services.conversationNavigation.listWorkspaces();
    if (services.conversationNavigation.getSelectedWorkspaceId() !== initialWorkspace
      || services.sessions.view.getSnapshot().selectedSessionId !== initialSession) return false;
    if (!services.conversationNavigation.isWorkspaceActive(target.workspaceId)) throw new Error('目标工作区已归档或不可访问。');
    await services.conversationNavigation.selectWorkspace(target.workspaceId);
  }
  if (services.conversationNavigation.getSelectedWorkspaceId() !== (target.workspaceId === PERSONAL_ASSISTANT_WORKSPACE_ID ? null : target.workspaceId)) return false;
  const selection = services.sessions.view.getSnapshot().selectedSessionId;
  if (selection !== initialSession && selection !== null && selection !== target.sessionId) return false;
  await services.sessions.select(target.sessionId);
  if (!ownsSelection()) return false;
  if (target.runId !== null) {
    await services.runs.openDetail(target.runId);
    if (!ownsSelection()) return false;
    const run = services.runs.view.getSnapshot().runs.find(candidate => candidate.runId === target.runId);
    if (run?.aggregateVersion !== target.expectedRunVersion) throw new Error('任务已变化或详情尚未同步，请刷新后重试。');
  }
  if (target.decisionId !== null && target.runId !== null && target.expectedDecisionVersion !== null) {
    await services.decisions.openDetail(target.decisionId);
    if (!ownsSelection()) return false;
    if (!services.decisions.isPendingDecisionLoaded(target.decisionId, target.runId, target.expectedDecisionVersion))
      throw new Error('待确认操作已变化，请刷新后重新选择。');
  }
  if (target.resultReference !== null) {
    const resolved = await services.sessions.resolveMessage(target.resultReference);
    if (resolved.workspaceId !== target.workspaceId || resolved.role !== 'assistant') throw new Error('结果不属于此任务会话。');
    if (!ownsSelection()) return false;
    await services.messages.showWindow({ kind: 'around', anchorMessageId: target.resultReference.messageId, limit: 32 });
    if (!ownsSelection()) return false;
  }
  services.events.emit('module:open', target.moduleId); return true;
}
