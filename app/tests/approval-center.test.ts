import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('application approval center', () => {
  it('moves pending proposals out of Chat into a bottom-right application surface', async () => {
    const root = join(process.cwd(), 'src', 'renderer', 'src');
    const [app, center, chat, styles] = await Promise.all([
      readFile(join(root, 'app', 'App.tsx'), 'utf8'),
      readFile(join(root, 'app', 'ApprovalCenter.tsx'), 'utf8'),
      readFile(join(root, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(root, 'app', 'styles.css'), 'utf8')
    ]);

    expect(app).toContain('<ApprovalCenter services={services} />');
    expect(center).toContain("proposal.status === 'pending'");
    expect(center).toContain("request.status === 'pending'");
    expect(center).toContain('respondToProposal');
    expect(center).toContain('respondToPermission');
    expect(center).toContain('runtimeRequestErrorMessage');
    expect(center).toContain('授权工作区：');
    expect(center).toContain('request.workspaceLabel');
    expect(center).toContain('submitting || !hasWorkspaceContext');
    expect(center).toContain("title: '启动 Agent'");
    expect(center).toContain("title: '具体操作授权'");
    expect(center).toContain("title: '恢复 Agent'");
    expect(center).toContain('resumePermission');
    expect(center).toContain('resumePlan');
    expect(center).toContain('className="primary-button"');
    expect(center).toContain('className="secondary-button"');
    expect(chat).not.toContain('AgentProposalCard');
    expect(chat).not.toContain('runtime.proposals');
    expect(styles).toMatch(/\.approval-center\s*\{[^}]*position:\s*fixed;[^}]*right:\s*18px;[^}]*bottom:\s*37px;/);
    expect(styles).toMatch(/\.approval-center\s*\{[^}]*background:\s*var\(--bg-1\);[^}]*box-shadow:\s*var\(--shadow-menu\);/);
    expect(styles).not.toMatch(/\.approval-center\s*\{[^}]*box-shadow:\s*var\(--shadow-dialog\);/);
    expect(styles).toMatch(/\.approval-center-icon\s*\{[^}]*color:\s*var\(--accent\);[^}]*background:\s*var\(--accent-soft\);/);
  });
});
