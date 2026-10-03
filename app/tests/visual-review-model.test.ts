import { describe, expect, it } from 'vitest';
import {
  collectReviewFiles,
  createEventReference,
  MOCK_REVIEW_SESSION
} from '../src/renderer/src/modules/visual-review/mock-review-session';

describe('Visual Review prototype model', () => {
  it('gives every changed file a completed event that can be inspected', () => {
    const files = collectReviewFiles(MOCK_REVIEW_SESSION.events);

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.eventIds.length > 0)).toBe(true);
    for (const file of files) {
      for (const eventId of file.eventIds) {
        const event = MOCK_REVIEW_SESSION.events.find((item) => item.id === eventId);
        expect(event?.status).toBe('completed');
        expect(event?.files.some((item) => item.path === file.path)).toBe(true);
      }
    }
  });

  it('builds an explicitly simulated Agent reference without hidden state', () => {
    const event = MOCK_REVIEW_SESSION.events.find((item) => item.id === 'demo-edit-panel');
    expect(event).toBeDefined();

    const reference = createEventReference(event!);
    expect(reference).toContain('【模拟·可视化审查引用】');
    expect(reference).toContain('VisualReviewPanel.tsx');
    expect(reference).toContain('事件引用：demo-edit-panel');
  });

  it('does not claim that the mock session is a real branch or session', () => {
    expect(MOCK_REVIEW_SESSION.id).toBe('DEMO-SESSION-NOT-REAL');
    expect(MOCK_REVIEW_SESSION.branch).toBe('DEMO-BRANCH');
    expect(MOCK_REVIEW_SESSION.title).toContain('【模拟】');
  });
});
