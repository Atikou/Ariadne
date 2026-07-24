import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');

describe('中文界面文案', () => {
  it('保留专业术语，但不直接显示英文状态值或英文操作文案', async () => {
    const sources = await Promise.all([
      join(rendererRoot, 'app', 'App.tsx'),
      join(rendererRoot, 'app', 'GlobalStatusBar.tsx'),
      join(rendererRoot, 'modules', 'agent-status', 'AgentStatusPanel.tsx'),
      join(rendererRoot, 'modules', 'agent-plan', 'AgentPlanPanel.tsx'),
      join(rendererRoot, 'modules', 'chat', 'ChatPanel.tsx'),
      join(rendererRoot, 'modules', 'chat', 'ConversationSidebar.tsx'),
      join(rendererRoot, 'modules', 'permissions', 'PermissionsPanel.tsx'),
      join(rendererRoot, 'modules', 'tool-output', 'ToolOutputPanel.tsx')
    ].map((path) => readFile(path, 'utf8')));
    const visibleSource = sources.join('\n');

    for (const forbidden of [
      'Runtime {runtime.status.availability}',
      '>New conversation<',
      '>Reject<',
      '>Approve once<',
      '>Deny<',
      '>Allow once<',
      '>Cancel run<',
      '>Start a conversation<',
      'No conversations yet.',
      'No model ready',
      'Agent idle',
      'Saving layout…'
    ]) {
      expect(visibleSource).not.toContain(forbidden);
    }

    expect(visibleSource).toContain('Runtime {formatRuntimeAvailability(runtime.status.availability)}');
    expect(visibleSource).toContain('Agent 空闲');
  });
});
