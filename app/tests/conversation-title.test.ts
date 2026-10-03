import { describe, expect, it } from 'vitest';
import { deriveConversationTitle } from '../src/renderer/src/modules/chat/conversation-title';

describe('deriveConversationTitle', () => {
  it('removes prompt filler and keeps the first thought compact', () => {
    expect(deriveConversationTitle('请帮我检查当前项目的会话标题实现，然后再运行测试')).toBe(
      '检查当前项目的会话标题实现，然后再运行测试'
    );
  });

  it('uses an attachment label for image-only first messages', () => {
    expect(deriveConversationTitle('', true)).toBe('图片消息');
  });

  it('keeps short titles unchanged so they remain natural to edit', () => {
    expect(deriveConversationTitle('修复标题')).toBe('修复标题');
  });
});
