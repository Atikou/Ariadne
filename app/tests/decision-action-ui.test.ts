import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('v3 Decision action UI', () => {
  it('offers only the migrated Permission and Plan actions and keeps resume disabled', async () => {
    const root = join(process.cwd(), 'src', 'renderer', 'src');
    const [approvalCenter, permissionPanel, planPanel] = await Promise.all([
      readFile(join(root, 'app', 'ApprovalCenter.tsx'), 'utf8'),
      readFile(join(root, 'modules', 'permissions', 'PermissionsPanel.tsx'), 'utf8'),
      readFile(join(root, 'modules', 'agent-plan', 'AgentPlanPanel.tsx'), 'utf8')
    ]);

    expect(approvalCenter).toContain("decision === 'allow' ? 'allow_once' : 'deny'");
    expect(approvalCenter).toContain('respondToPlan(handoff, decision)');
    expect(permissionPanel).toContain("respondToPermission(request, 'allow_once')");
    expect(permissionPanel).toContain("respondToPermission(request, 'deny')");
    expect(permissionPanel).not.toContain('allow_session');
    expect(permissionPanel).not.toContain('allow_project');
    expect(permissionPanel).not.toContain('allow_workspace');
    expect(permissionPanel).not.toContain('resumePermission');
    expect(planPanel).toContain("respondToPlan(handoff, 'approve')");
    expect(planPanel).toContain("respondToPlan(handoff, 'reject')");
    expect(planPanel).not.toContain('resumePlan');
    for (const source of [approvalCenter, permissionPanel, planPanel]) {
      expect(source).not.toContain('actionToken');
      expect(source).not.toContain('decision-action.v1:');
    }
  });
});
