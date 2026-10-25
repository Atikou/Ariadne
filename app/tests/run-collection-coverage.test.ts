import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RunCollectionControls } from '../src/renderer/src/shared/ui/RunCollectionControls';
import { AgentInboxPanel } from '../src/renderer/src/modules/chat/AgentInboxPanel';
import { SessionActivityPanel } from '../src/renderer/src/modules/session-activity/SessionActivityPanel';
import { presentRun } from '../src/renderer/src/core/runtime/runtime-projection-presenter';
import type { RunFeatureStore } from '../src/renderer/src/core/runtime/features/run-feature-store';
import type { ModuleServices, FeaturePanelProps } from '../src/renderer/src/core/modules/module-contract';
import { run, presentationRun, NOW } from './projection-v3-fixture';

it('states unloaded and partial collection coverage without implying earlier ordinals were read', () => {
  const coverage = { state: 'unloaded' as const, total: 150, startOrdinal: 0, count: 0, hasEarlier: false, hasMore: true };
  const unread = renderToStaticMarkup(createElement(RunCollectionControls, { label: '输入', coverage, owner: 'fixture', onRead: async () => undefined }));
  expect(unread).toContain('输入未加载，共 150 项'); expect(unread).toContain('加载记录');
  const last = renderToStaticMarkup(createElement(RunCollectionControls, { label: '输入', coverage: { ...coverage, state: 'partial', startOrdinal: 128,
    count: 22, hasEarlier: true, hasMore: false }, owner: 'fixture', onRead: async () => undefined }));
  expect(last).toContain('129–150 / 150'); expect(last).toContain('仅当前页'); expect(last).toContain('第一页');
});
it('shows unread Inbox content as a body action and disables edit until a complete body exists', () => {
  const presented = presentRun(presentationRun({ ...run('run-a'), inbox: [{ inputId: 'input-a', messageId: 'message-a', version: 1, content: 'COMPLETE_BODY',
    delivery: 'next_turn', state: 'queued', queuedAt: NOW, updatedAt: NOW }] }));
  const { content: _content, ...metadata } = presented.inbox[0]!;
  const reads = {} as RunFeatureStore;
  const unread = renderToStaticMarkup(createElement(AgentInboxPanel, { run: { ...presented, inbox: [{ ...metadata, bodyState: 'unloaded' }] }, reads }));
  expect(unread).toContain('正文未加载'); expect(unread).toContain('读取正文'); expect(unread).not.toContain('COMPLETE_BODY');
  expect(unread).toMatch(/<button[^>]*disabled[^>]*>编辑<\/button>/u);
  const loaded = renderToStaticMarkup(createElement(AgentInboxPanel, { run: presented, reads }));
  expect(loaded).toContain('COMPLETE_BODY'); expect(loaded).not.toContain('正文未加载');
});
it('does not label a nonempty unloaded Tool collection as no tool calls', () => {
  const presented = presentRun(presentationRun(run('run-a')));
  presented.collections = { ...presented.collections, toolActivities: { state: 'unloaded', total: 150, startOrdinal: 0, count: 0, hasEarlier: false, hasMore: true } };
  const source = <T,>(snapshot: T) => ({ getSnapshot: () => snapshot, subscribe: () => () => undefined });
  const services = { runs: { view: source({ runs: [presented], activities: [] }) }, sessions: { view: source({ selectedSessionId: 'session-a' }) } } as unknown as ModuleServices;
  const html = renderToStaticMarkup(createElement(SessionActivityPanel, { moduleId: 'fixture', services } as FeaturePanelProps));
  expect(html).toContain('工具记录尚未加载'); expect(html).not.toContain('没有工具调用');
});
