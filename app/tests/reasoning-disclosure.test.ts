import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RunSummary } from '@ariadne/protocol/public';

import {
  RunProcessingDisclosure,
  formatProcessingDuration,
} from '../src/renderer/src/modules/chat/RunProcessingDisclosure';
import { conversationTextForDisplay } from '../src/renderer/src/modules/chat/conversation-node';

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    origin: 'companion',
    title: 'test',
    status: 'running',
    userFacingLabel: '正在处理',
    aggregateVersion: 1,
    startedAt: '2026-07-22T00:00:00.000Z',
    checkpointStage: 'running',
    recoveryStatus: 'none',
    timing: { activeDurationMs: 5_000 },
    ...overrides,
  };
}

describe('RunProcessingDisclosure', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses one expanded processing area for reasoning, tools, and compression', () => {
    const html = renderToStaticMarkup(createElement(RunProcessingDisclosure, {
      run: run(),
      reasoning: {
        content: '正在核对约束。',
        status: 'streaming',
        source: 'provider',
        startedAt: '2026-07-22T00:00:00.000Z',
      },
      activities: [
        {
          activityType: 'system',
          activityId: 'compact-1',
          runId: 'run-1',
          kind: 'context_compaction',
          status: 'running',
          title: '正在自动压缩上下文',
          occurredAt: '2026-07-22T00:00:04.000Z',
        },
        {
          activityType: 'tool',
          activityId: 'tool-1',
          runId: 'run-1',
          toolCallId: 'call-1',
          toolName: 'read_file',
          status: 'completed',
          title: '读取文件',
          occurredAt: '2026-07-22T00:00:01.000Z',
          iteration: 1,
          batchId: 'batch-1',
          laneId: 'main',
          dependsOnActivityIds: [],
          detailAvailable: true,
          changedFileCount: 0,
        },
      ],
    }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('正在处理 5s');
    expect(html).toContain('正在自动压缩上下文');
    expect(html).toContain('正在核对约束。');
    expect(html).toContain('已读取文件');
    expect((html.match(/正在处理/g) ?? [])).toHaveLength(1);
  });

  it('interleaves Agent narration with grouped tool batches while the same Run is open', () => {
    const html = renderToStaticMarkup(createElement(RunProcessingDisclosure, {
      run: run({ status: 'waiting_plan_handoff' }),
      reasoning: {
        content: '先检查文件。\n\n这是阶段性计划。',
        status: 'streaming',
        source: 'summary',
        startedAt: '2026-07-22T00:00:00.000Z',
        segments: [
          {
            segmentId: 'segment-1',
            kind: 'thought',
            content: '先检查文件。',
            occurredAt: '2026-07-22T00:00:01.000Z',
            iteration: 1,
          },
          {
            segmentId: 'segment-2',
            kind: 'intermediate_response',
            content: '这是阶段性计划。',
            occurredAt: '2026-07-22T00:00:03.000Z',
          },
        ],
      },
      activities: [
        toolActivity('tool-1', 'call-1'),
        toolActivity('tool-2', 'call-2'),
      ],
    }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('等待计划确认');
    expect(html).toContain('运行了 2 个工具');
    expect((html.match(/读取文件/g) ?? [])).toHaveLength(2);
    expect(html.indexOf('先检查文件。')).toBeLessThan(html.indexOf('运行了 2 个工具'));
    expect(html.indexOf('运行了 2 个工具')).toBeLessThan(html.indexOf('这是阶段性计划。'));
  });

  it('starts collapsed with the final active processing duration', () => {
    const html = renderToStaticMarkup(createElement(RunProcessingDisclosure, {
      run: run({
        status: 'completed',
        completedAt: '2026-07-22T00:06:21.000Z',
        timing: { activeDurationMs: 381_000 },
      }),
      reasoning: {
        content: '已经核对约束。',
        status: 'completed',
        source: 'provider',
        startedAt: '2026-07-22T00:00:00.000Z',
        completedAt: '2026-07-22T00:06:21.000Z',
        durationMs: 381_000,
      },
      activities: [],
    }));

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('已处理 6m 21s');
    expect(html).not.toContain('已经核对约束。');
    expect((html.match(/已处理/g) ?? [])).toHaveLength(1);
  });

  it('adds the current active interval to the persisted Run duration', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:08.000Z'));

    const html = renderToStaticMarkup(createElement(RunProcessingDisclosure, {
      run: run({
        timing: {
          activeDurationMs: 5_000,
          activeSince: '2026-07-22T00:00:05.000Z',
        },
      }),
      activities: [],
    }));

    expect(html).toContain('正在处理 8s');
  });

  it('keeps the disclosure running across a handoff before the Agent Run arrives', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:08.000Z'));

    const html = renderToStaticMarkup(createElement(RunProcessingDisclosure, {
      messageStatus: 'streaming',
      reasoning: {
        content: '已完成前置分析。',
        status: 'completed',
        source: 'provider',
        startedAt: '2026-07-22T00:00:00.000Z',
        completedAt: '2026-07-22T00:00:02.000Z',
        durationMs: 2_000,
      },
      activities: [],
    }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('正在处理 8s');
    expect(html).toContain('已完成前置分析。');
    expect(html).not.toContain('已处理');
  });

  it('formats short and minute-scale durations', () => {
    expect(formatProcessingDuration(0)).toBe('1s');
    expect(formatProcessingDuration(7_500)).toBe('8s');
    expect(formatProcessingDuration(381_000)).toBe('6m 21s');
  });

  it('shows assistant tokens while reasoning and the Agent Run are still active', () => {
    expect(conversationTextForDisplay({
      kind: 'streaming',
      summary: '正在处理…',
      content: '回答的第一段',
    })).toBe('回答的第一段');
    expect(conversationTextForDisplay({
      kind: 'streaming',
      summary: '正在处理…',
    })).toBe('');
    expect(conversationTextForDisplay({
      kind: 'user',
      summary: '用户消息',
    })).toBe('用户消息');
  });
});

function toolActivity(activityId: string, toolCallId: string) {
  return {
    activityType: 'tool' as const,
    activityId,
    runId: 'run-1',
    toolCallId,
    toolName: 'read_file',
    status: 'completed' as const,
    title: '读取文件',
    occurredAt: '2026-07-22T00:00:02.000Z',
    iteration: 1,
    batchId: 'batch-1',
    laneId: 'main',
    dependsOnActivityIds: [],
    detailAvailable: true,
    changedFileCount: 0,
  };
}
