import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Production UI -> public owner -> pinned Agent memory Tools -> exact protected results. */
export async function verifyLongMemory(window: BrowserWindow, workspaceId: string, outputRoot: string, existingSessionId?: string): Promise<void> {
  const capturePhase = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.message.startsWith('MEMORY_UI_PHASE:')) console.info(details.message);
  };
  window.webContents.on('console-message', capturePhase);
  try {
  const evidence = await window.webContents.executeJavaScript(`(async () => {
    const scope = { contractVersion: '5.0', workspaceId: ${JSON.stringify(workspaceId)}, sessionId: ${JSON.stringify(existingSessionId)} ?? crypto.randomUUID() };
    const request = async command => { const result = await window.ariadne.runtime.request(command);
      if (!result.ok) throw new Error('memory_smoke_request_failed:' + command.kind + ':' + result.error.code); return result.value; };
    const query = () => request({ ...scope, kind: 'memory.query', scope: null, status: 'all', before: null, limit: 100 });
    const snapshot = async (selection = {}) => window.__ariadneSmokeProjection.readFixtureWindow(${JSON.stringify(workspaceId)}, selection);
    let phase = 'create';
    const waitFor = async predicate => { const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
      throw new Error('memory_smoke_timeout:' + phase + ':' + JSON.stringify({ memories: await query(), panel: document.querySelector('.memory-panel')?.textContent })); };
    const button = text => Array.from(document.querySelectorAll('.memory-panel button')).find(item => item.textContent === text && !item.disabled);
    const refresh = async () => {
      (await waitFor(() => button('刷新'))).click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await waitFor(() => button('刷新'));
    };
    const trace = () => console.info('MEMORY_UI_PHASE:' + JSON.stringify({ phase,
      listRows: document.querySelectorAll('[aria-label=记忆列表] button').length,
      selectedRows: document.querySelectorAll('[aria-label=记忆列表] [aria-pressed=true]').length,
      editing: !!document.querySelector('.memory-editor'), refreshing: !button('刷新') }));
    const input = (selector, value) => { const element = document.querySelector(selector); const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); };
    const verifyRefreshEditing = async reviewed => {
    phase = 'production_refresh_conflict';
    await refresh(); trace();
    (await waitFor(() => Array.from(document.querySelectorAll('[aria-label=记忆列表] button')).find(item => item.textContent === reviewed.title && !item.disabled))).click();
    (await waitFor(() => button('编辑记忆'))).click();
    await waitFor(() => document.querySelector('[aria-label=记忆内容]'));
    trace();
    const retainedTitle = '【验收夹具】刷新保留的本地标题';
    input('[aria-label=记忆标题]', retainedTitle);
    input('[aria-label=记忆重要性]', '0.6');
    const content = { scope: reviewed.scope, memoryType: reviewed.memoryType, title: '【验收夹具】后台更新记忆', content: reviewed.content,
      importance: reviewed.importance, confidence: reviewed.confidence, sensitivity: reviewed.sensitivity, retentionUntil: reviewed.retentionUntil };
    await request({ ...scope, ...content, kind: 'memory.put', memoryId: reviewed.memoryId, expectedVersion: reviewed.version });
    await refresh(); trace();
    await waitFor(() => document.querySelector('[aria-label=记忆版本冲突]'));
    if (document.querySelector('[aria-label=记忆标题]').value !== retainedTitle || document.querySelector('[aria-label=记忆重要性]').value !== '0.6'
      || !document.querySelector('.memory-editor button[type=submit]').disabled) throw new Error('memory_smoke_refresh_overwrote_draft');
    (await waitFor(() => button('保留输入，采用当前版本'))).click();
    (await waitFor(() => button('保存记忆'))).click();
    const reconciled = await waitFor(async () => (await query()).memories.find(item => item.memoryId === reviewed.memoryId && item.version === 3));
    if (reconciled.title !== retainedTitle || reconciled.importance !== .6 || reconciled.content !== reviewed.content) throw new Error('memory_smoke_rebased_cas_invalid');
    await waitFor(() => !document.querySelector('.memory-editor'));
    (await waitFor(() => Array.from(document.querySelectorAll('[aria-label=记忆列表] button')).find(item => item.textContent === retainedTitle && !item.disabled))).click();
    (await waitFor(() => button('编辑记忆'))).click();
    await waitFor(() => document.querySelector('[aria-label=记忆内容]'));
    const retainedCopy = '【验收夹具】删除后仍保留的记忆副本';
    input('[aria-label=记忆内容]', retainedCopy);
    await request({ ...scope, kind: 'memory.delete', memoryId: reviewed.memoryId, expectedVersion: 3 });
    await refresh(); trace();
    await waitFor(() => document.querySelector('.memory-editor [role=alert]')?.textContent.includes('不会自动创建'));
    if (document.querySelector('[aria-label=记忆内容]').value !== retainedCopy || !document.querySelector('.memory-editor button[type=submit]').disabled
      || (await query()).memories.some(item => item.memoryId === reviewed.memoryId || item.content === retainedCopy)) throw new Error('memory_smoke_deleted_draft_recreated');
    (await waitFor(() => button('取消编辑'))).click();

      return { actualRefreshPreservedDirtyMemory: true, explicitMemoryRebaseSavedVersion: reconciled.version, actualDeletionKeptCopyWithoutCreation: true };
    };
    if (${JSON.stringify(existingSessionId)} !== undefined) {
      await window.__ariadneRendererCompositionRootV1.services.sessions.select(scope.sessionId);
      document.querySelector('.module-menu > button').click();
      (await waitFor(() => Array.from(document.querySelectorAll('.module-option')).find(item => item.querySelector('strong')?.textContent === '长期记忆'))).click();
      const reviewed = (await query()).memories.find(memory => memory.status === 'active' && memory.version === 1 && memory.content.includes('ARIADNE_SMOKE_REVIEWED_MEMORY'));
      if (!reviewed) throw new Error('memory_refresh_revisit_fixture_missing');
      return { passed: true, sessionId: scope.sessionId, reviewedMemoryId: reviewed.memoryId, ...await verifyRefreshEditing(reviewed),
        source: 'actual isolated Main/Memory owner/SQLite/Renderer; existing deterministic fixture, no new session or Provider-quality claim' };
    }
    await request({ ...scope, kind: 'conversation.session.create', title: '【验收夹具】真实长期记忆' });
    await waitFor(async () => (await snapshot()).sessions.some(session => session.sessionId === scope.sessionId));
    await window.__ariadneRendererCompositionRootV1.services.sessions.select(scope.sessionId);
    document.querySelector('.module-menu > button').click();
    (await waitFor(() => Array.from(document.querySelectorAll('.module-option')).find(item => item.querySelector('strong')?.textContent === '长期记忆'))).click();
    phase = 'production_editor'; (await waitFor(() => button('新增记忆'))).click();
    await waitFor(() => document.querySelector('[aria-label=记忆标题]'));
    input('[aria-label=记忆标题]', '【验收夹具】已审核记忆'); input('[aria-label=记忆内容]', 'ARIADNE_SMOKE_REVIEWED_MEMORY 回答应使用中文');
    (await waitFor(() => button('保存记忆'))).click();
    const reviewed = await waitFor(async () => (await query()).memories.find(memory => memory.content.includes('ARIADNE_SMOKE_REVIEWED_MEMORY')));
    if (reviewed.status !== 'active' || reviewed.provenance.kind !== 'user' || reviewed.reviewedAt === null) throw new Error('memory_smoke_user_review_missing');
    const allowed = new Set();
    const runScenario = async (scenario, marker, extra = '') => {
      const projection = await snapshot(); const version = projection.sessions.find(session => session.sessionId === scope.sessionId).version;
      await request({ ...scope, kind: 'conversation.message.accept', expectedSessionVersion: version,
        messageId: crypto.randomUUID(), content: 'ariadne-smoke:' + scenario + ' ' + extra, execution: { mode: 'agent' } });
      return waitFor(async () => {
        const state = await snapshot();
        for (const decision of state.decisions) if (decision.sessionId === scope.sessionId && decision.kind === 'permission' && decision.status === 'pending' && decision.action && !allowed.has(decision.decisionId)) {
          allowed.add(decision.decisionId); await request({ kind: 'agent.decision.resolve', contractVersion: '5.0', runId: decision.runId, decisionId: decision.decisionId,
            action: { contractVersion: decision.action.contractVersion, actionToken: decision.action.actionToken, choice: 'allow_once' } });
        }
        const message = state.messages.find(message => message.sessionId === scope.sessionId && message.role === 'assistant' && message.content === marker);
        const run = message && state.runs.find(run => run.runId === message.runId);
        return run?.status === 'completed' ? run : null;
      });
    };
    phase = 'actual_agent_tools'; const stageRun = await runScenario('memory_stage', 'ARIADNE_SMOKE_MEMORY_STAGE_VERIFIED');
    const candidate = (await query()).memories.find(memory => memory.content === 'ARIADNE_SMOKE_CANDIDATE_MEMORY');
    if (!candidate || candidate.status !== 'candidate' || candidate.reviewedAt !== null || candidate.provenance.runId !== stageRun.runId) throw new Error('memory_smoke_candidate_invalid');
    const candidateRecall = await request({ ...scope, kind: 'memory.recall', query: 'ARIADNE_SMOKE_CANDIDATE_MEMORY', limit: 20 });
    if (candidateRecall.hits.some(hit => hit.memory.memoryId === candidate.memoryId)) throw new Error('memory_smoke_candidate_recalled');
    phase = 'user_activation'; await refresh(); trace();
    (await waitFor(() => Array.from(document.querySelectorAll('[aria-label=记忆列表] button')).find(button => button.textContent === candidate.title && !button.disabled))).click();
    (await waitFor(() => button('审核并启用'))).click();
    await waitFor(async () => (await query()).memories.some(memory => memory.memoryId === candidate.memoryId && memory.version === 2 && memory.status === 'active'));
    phase = 'production_edit'; (await waitFor(() => button('编辑记忆'))).click();
    await waitFor(() => document.querySelector('[aria-label=记忆内容]'));
    input('[aria-label=记忆内容]', 'ARIADNE_SMOKE_EDITED_MEMORY'); (await waitFor(() => button('保存记忆'))).click();
    const edited = await waitFor(async () => (await query()).memories.find(memory => memory.memoryId === candidate.memoryId && memory.version === 3));
    if (edited.content !== 'ARIADNE_SMOKE_EDITED_MEMORY' || edited.status !== 'active' || edited.provenance.kind !== 'user') throw new Error('memory_smoke_edit_invalid');
    phase = 'actual_agent_updated_read'; const readRun = await runScenario('memory_read', 'ARIADNE_SMOKE_MEMORY_READ_VERIFIED', 'memoryId=' + candidate.memoryId);
    phase = 'production_forget'; (await waitFor(() => Array.from(document.querySelectorAll('[aria-label=记忆列表] button')).find(button => button.textContent === candidate.title && !button.disabled))).click();
    (await waitFor(() => button('忘记记忆'))).click(); (await waitFor(() => button('确认忘记'))).click();
    await waitFor(async () => !(await query()).memories.some(memory => memory.memoryId === candidate.memoryId));
    phase = 'actual_agent_forget_read'; const forgetRun = await runScenario('memory_forget', 'ARIADNE_SMOKE_MEMORY_FORGET_VERIFIED', 'memoryId=' + candidate.memoryId);
    const finalRecall = await request({ ...scope, kind: 'memory.recall', query: 'ARIADNE_SMOKE_EDITED_MEMORY', limit: 20 });
    if (finalRecall.hits.some(hit => hit.memory.memoryId === candidate.memoryId)) throw new Error('memory_smoke_forgotten_recalled');
    if (finalRecall.embedding.capability !== 'lexical_approximation' || !finalRecall.embedding.degraded) throw new Error('memory_smoke_lexical_mislabeled');
    const refreshEvidence = await verifyRefreshEditing(reviewed);
    return { passed: true, workspaceId: scope.workspaceId, sessionId: scope.sessionId, reviewedMemoryId: reviewed.memoryId,
      forgottenMemoryId: candidate.memoryId, reviewedVersion: reviewed.version, forgottenVersion: 4, stageRunId: stageRun.runId,
      readRunId: readRun.runId, forgetRunId: forgetRun.runId, actualProviderInstructionContextVerified: true,
      actualPinnedRecallReadAndCandidateToolsVerified: true, candidateExcludedBeforeUserReview: true, productionRendererCreatedEditedReviewedAndForgot: true,
      ...refreshEvidence,
      explicitToolPermissionsResolved: allowed.size, embedding: finalRecall.embedding };
  })()`, true);
  await writeFile(join(outputRoot, existingSessionId ? 'memory-refresh-editing-execution.json' : 'long-memory-execution.json'), JSON.stringify(evidence, null, 2), 'utf8');
  } finally { window.webContents.removeListener('console-message', capturePhase); }
}
