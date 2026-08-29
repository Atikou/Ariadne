import type { AgentJsonValue } from '@ariadne/agent-core';

export interface ProtectedAgentUserQuestionOptionV1 {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

export interface ProtectedAgentUserQuestionV1 {
  readonly format: 'ariadne.user-question';
  readonly schemaVersion: 1;
  readonly prompt: string;
  readonly options?: readonly ProtectedAgentUserQuestionOptionV1[];
}

export function parseProtectedAgentUserQuestion(
  value: AgentJsonValue
): ProtectedAgentUserQuestionV1 {
  if (!isRecord(value)) throw invalid();
  const keys = Object.keys(value).sort();
  const expected = value.options === undefined
    ? ['format', 'prompt', 'schemaVersion']
    : ['format', 'options', 'prompt', 'schemaVersion'];
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || value.format !== 'ariadne.user-question'
    || value.schemaVersion !== 1
    || !boundedText(value.prompt, 8_192)
  ) throw invalid();

  const options = value.options;
  if (options === undefined) {
    return {
      format: 'ariadne.user-question',
      schemaVersion: 1,
      prompt: value.prompt
    };
  }
  if (!Array.isArray(options) || options.length < 2 || options.length > 8) {
    throw invalid();
  }
  const ids = new Set<string>();
  const parsed = options.map((option): ProtectedAgentUserQuestionOptionV1 => {
    if (!isRecord(option)) throw invalid();
    const optionKeys = Object.keys(option).sort();
    const optionExpected = option.description === undefined
      ? ['label', 'optionId']
      : ['description', 'label', 'optionId'];
    if (
      optionKeys.length !== optionExpected.length
      || optionKeys.some((key, index) => key !== optionExpected[index])
      || !canonicalId(option.optionId)
      || !boundedText(option.label, 256)
      || (option.description !== undefined && !boundedText(option.description, 1_024))
      || ids.has(option.optionId)
    ) throw invalid();
    ids.add(option.optionId);
    return {
      optionId: option.optionId,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description })
    };
  });
  return {
    format: 'ariadne.user-question',
    schemaVersion: 1,
    prompt: value.prompt,
    options: parsed
  };
}

export function renderProtectedAgentUserQuestion(
  question: ProtectedAgentUserQuestionV1
): string {
  if (question.options === undefined) return question.prompt;
  return [
    question.prompt,
    ...question.options.map((option) => (
      `- ${option.label}${option.description === undefined ? '' : `: ${option.description}`}`
    ))
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= limit
    && value.trim().length > 0;
}

function invalid(): Error {
  return new Error('protected_agent_user_question_invalid');
}
