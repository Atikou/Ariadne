import type { BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Opens the actual registered panels against production Main/Runtime services. */
export async function verifyModuleOpening(window: BrowserWindow, outputRoot: string): Promise<void> {
  const result = await window.webContents.executeJavaScript(`(async () => {
    const wait = async (probe, label) => {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        const error = document.querySelector('.module-panel-error');
        if (error) throw new Error('module_render_failed:' + label + ':' + error.textContent);
        const value = probe(); if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('module_open_timeout:' + label);
    };
    const visible = selector => [...document.querySelectorAll(selector)].find(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0);
    const sessions = window.__ariadneRendererCompositionRootV1.services.sessions;
    if (!sessions.view.getSnapshot().selectedSessionId) {
      const session = sessions.view.getSnapshot().sessions.find(item => item.status !== 'archived');
      if (!session) throw new Error('module_opening_fixture_session_missing');
      await sessions.select(session.sessionId);
    }
    const selectors = {
      'Agent 状态': '.agent-status-panel', '执行计划': '.agent-plan-panel', '对话': '.chat-panel',
      '文件': '.file-explorer', '日志': '.logs-panel', '长期记忆': '.memory-panel',
      '权限': '[aria-labelledby="permissions-title"]', '目标与工作流': '.productivity-panel',
      '会话活动': '.session-activity-panel', '设置': '.settings-dialog', '任务中心': '.task-center-panel',
      '终端': '.terminal-panel', '工具输出': '.tool-output-panel', '可视化审查': '.visual-review-panel'
    };
    const trigger = () => document.querySelector('.module-menu > button');
    trigger().click();
    await wait(() => document.querySelector('.module-option'), 'menu');
    const names = [...document.querySelectorAll('.module-option strong')].map(e => e.textContent);
    trigger().click();
    const panels = [], settingsCategories = [];
    for (const name of names) {
      if (!selectors[name]) throw new Error('module_missing_acceptance:' + name);
      trigger().click();
      const option = await wait(() => [...document.querySelectorAll('.module-option')].find(e => e.querySelector('strong')?.textContent === name), name);
      option.click();
      await wait(() => visible(selectors[name]), name);
      await new Promise(resolve => setTimeout(resolve, 150));
      if (document.querySelector('.module-panel-error')) throw new Error('module_render_failed:' + name);
      panels.push({ name, opened: true });
      if (name === '设置') {
        const categories = [...document.querySelectorAll('.settings-navigation button')].map(e => e.title);
        for (const category of categories) {
          [...document.querySelectorAll('.settings-navigation button')].find(e => e.title === category).click();
          await wait(() => visible('.settings-content-scroll'), category);
          await new Promise(resolve => setTimeout(resolve, 150));
          if (document.querySelector('.module-panel-error')) throw new Error('settings_render_failed:' + category);
          settingsCategories.push(category);
        }
        document.querySelector('[aria-label="关闭设置"]').click();
      }
    }
    return { passed: true, panels, settingsCategories, source: 'production panels and declared services; isolated real Main and Runtime' };
  })()`, true);
  await writeFile(join(outputRoot, 'module-opening.json'), JSON.stringify(result, null, 2), 'utf8');
}
