import { describe, expect, it } from 'vitest';

import { renderAssistantChatInstructions } from '../src/composition/runtime-capabilities/AgentInstructionCapabilityProviders.js';

describe('assistant chat profile instructions', () => {
  it('renders the configured assistant persona with direct-answer instructions', () => {
    const instructions = renderAssistantChatInstructions({
      name: '小雅',
      systemPrompt: '使用轻松、简洁的中文回答。',
      userPersona: ''
    });

    expect(instructions).toContain('Assistant name: 小雅');
    expect(instructions).toContain('使用轻松、简洁的中文回答。');
    expect(instructions).toContain('Answer directly and naturally.');
    expect(instructions).toContain('Do not add Ariadne-specific topic filtering');
    expect(instructions).not.toContain('Configured user persona:');
    expect(instructions).not.toContain('content mode');
  });

  it('includes a configured user persona without expanding execution authority', () => {
    const instructions = renderAssistantChatInstructions({
      name: 'Ariadne',
      systemPrompt: '直接回答用户。',
      userPersona: '用户偏好简洁中文，目前正在学习编程。'
    });

    expect(instructions).toContain('Configured user persona:');
    expect(instructions).toContain('用户偏好简洁中文，目前正在学习编程。');
    expect(instructions).toContain('Execution authority is unchanged by either persona.');
    expect(instructions).toContain('Never modify, delete, move, create, or execute files or commands.');
  });
});
