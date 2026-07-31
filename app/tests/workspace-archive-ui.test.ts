import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('workspace archive UI contract', () => {
  it('exposes pin/archive actions without a workspace count and restores archives from Settings', async () => {
    const rendererRoot = join(process.cwd(), 'src', 'renderer', 'src');
    const [sidebar, settings, styles, preload, application] = await Promise.all([
      readFile(join(rendererRoot, 'modules', 'chat', 'ConversationSidebar.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'modules', 'settings', 'SettingsPanel.tsx'), 'utf8'),
      readFile(join(rendererRoot, 'app', 'styles.css'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'main', 'application.ts'), 'utf8')
    ]);

    expect(sidebar).toContain('conversation-workspace-actions');
    expect(sidebar).toContain('<Pin size={13} />');
    expect(sidebar).toContain('<Archive size={13} />');
    expect(sidebar).not.toContain('sessions.length');
    expect(sidebar).not.toContain('workspace-conversation-list');
    expect(settings).toContain('已归档工作区');
    expect(settings).toContain('归档后保留 7 天');
    expect(settings).toContain('services.conversationNavigation.restoreWorkspace(workspaceId)');
    expect(styles).toMatch(/\.archived-workspace-card\s*\{/);
    expect(preload).toContain('agentWorkspaceArchive');
    expect(preload).toContain('agentWorkspaceRestore');
    expect(preload).toContain('agentWorkspacesChanged');
    expect(application).toContain("kind: 'companion.workspaces.purge'");
    expect(application).toContain('markWorkspacePurged(workspaceId)');
    expect(application).toContain('scheduleArchivedWorkspaceCleanup(60_000)');
  });
});
