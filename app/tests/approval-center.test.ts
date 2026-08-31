import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('conversation-scoped approval cards', () => {
  it('renders pending approvals inside only their owning conversation', async () => {
    const root = join(process.cwd(), 'src', 'renderer', 'src');
    const [app, cards, chat, styles] = await Promise.all([
      readFile(join(root, 'app', 'App.tsx'), 'utf8'),
      readFile(join(root, 'app', 'ApprovalCenter.tsx'), 'utf8'),
      readFile(join(root, 'modules', 'chat', 'ChatPanel.tsx'), 'utf8'),
      readFile(join(root, 'app', 'styles.css'), 'utf8')
    ]);

    expect(app).not.toContain('<ApprovalCenter');
    expect(cards).toContain('export function ConversationApprovalCards');
    expect(cards).toContain('resolveProjectionApprovalSessionId');
    expect(cards).not.toContain("from '@shared/conversation-approval-state'");
    expect(cards).not.toContain("proposal.status === 'pending'");
    expect(cards).toContain("request.status === 'pending'");
    expect(cards).toContain("handoff.status === 'pending'");
    expect(cards).not.toContain('...snapshot.proposals');
    expect(cards).not.toContain('respondToProposal');
    expect(cards).toContain('respondToPermission');
    expect(cards).toContain('respondToPlan');

    expect(chat).toContain('onApprovalNavigation');
    expect(chat).toContain('services.sessions.select(sessionId)');
    expect(chat).toContain('<ConversationApprovalCards');
    expect(chat).toContain('sessionId={runtime.selectedSessionId}');

    expect(styles).toMatch(/\.conversation-approval-stack\s*\{[^}]*display:\s*grid;/);
    expect(styles).toMatch(/\.approval-center\s*\{[^}]*width:\s*100%;/);
    expect(styles).not.toMatch(/\.approval-center\s*\{[^}]*position:\s*fixed;/);
    expect(styles).not.toMatch(/\.approval-center\s*\{[^}]*right:\s*18px;/);
    expect(styles).not.toMatch(/\.approval-center\s*\{[^}]*bottom:\s*37px;/);
  });
});
