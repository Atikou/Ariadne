import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  coalesceTraceLogs,
  traceLogCategory,
  traceMatchesLevel,
  traceMatchesView,
  traceMessageForDisplay,
  traceMetadataForDisplay
} from '../src/shared/log-entry-presentation';

describe('Logs panel presentation', () => {
  it('does not display an empty or category-identical trace message', () => {
    expect(traceMessageForDisplay({ category: 'runtime.ready', message: '' })).toBeNull();
    expect(traceMessageForDisplay({
      category: 'assistant_agent_proposal_settled',
      message: 'assistant_agent_proposal_settled'
    })).toBeNull();
  });

  it('preserves a distinct public trace message', () => {
    expect(traceMessageForDisplay({
      category: 'runtime.request.error',
      message: '模型服务暂时不可用。'
    })).toBe('模型服务暂时不可用。');
  });

  it('renders structured diagnostic metadata for inspection', () => {
    expect(traceMetadataForDisplay({
      category: 'companion.proposal.protocol',
      message: '协议校验失败',
      metadata: {
        lifecycleStage: 'schema_validation',
        fieldPaths: ['risk'],
        retryable: true
      }
    })).toBe([
      '{',
      '  "lifecycleStage": "schema_validation",',
      '  "fieldPaths": [',
      '    "risk"',
      '  ],',
      '  "retryable": true',
      '}'
    ].join('\n'));
  });

  it('defaults to high-signal logs while keeping category and severity filters available', () => {
    const routineModel = {
      category: 'model.request',
      message: '正在调用模型',
      level: 'info' as const
    };
    const warning = {
      category: 'provider.retry',
      message: '远程服务正在重试',
      level: 'warning' as const
    };
    const runStarted = {
      category: 'run_start',
      message: '任务已开始',
      level: 'info' as const
    };

    expect(traceMatchesView(routineModel, 'important')).toBe(false);
    expect(traceMatchesView(routineModel, 'model')).toBe(true);
    expect(traceMatchesView(warning, 'important')).toBe(true);
    expect(traceMatchesView(runStarted, 'important')).toBe(true);
    expect(traceMatchesLevel(warning, 'warning')).toBe(true);
    expect(traceMatchesLevel(runStarted, 'warning')).toBe(false);
  });

  it('classifies tool, network, model, security, Agent, and system logs', () => {
    expect(traceLogCategory({ category: 'tool_audit' })).toBe('tool');
    expect(traceLogCategory({ category: 'browser.network.error' })).toBe('network');
    expect(traceLogCategory({ category: 'model.response' })).toBe('model');
    expect(traceLogCategory({ category: 'path_access_decision' })).toBe('security');
    expect(traceLogCategory({ category: 'agent_run_end' })).toBe('agent');
    expect(traceLogCategory({ category: 'runtime.ready' })).toBe('system');
  });

  it('coalesces repeated low-value rows inside a short window', () => {
    const base = {
      category: 'model.request',
      message: '正在调用模型',
      level: 'info' as const
    };
    const rows = coalesceTraceLogs([
      { ...base, occurredAt: '2026-07-30T00:00:00.000Z' },
      { ...base, occurredAt: '2026-07-30T00:00:00.500Z' },
      { ...base, occurredAt: '2026-07-30T00:00:04.000Z' }
    ]);

    expect(rows.map((row) => row.repeats)).toEqual([2, 1]);
  });

  it('renders a compact filter toolbar and flexible concise log rows', async () => {
    const [panel, styles] = await Promise.all([
      readFile(join(process.cwd(), 'src', 'renderer', 'src', 'modules', 'logs', 'LogsPanel.tsx'), 'utf8'),
      readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8')
    ]);

    expect(panel).toContain("useState<LogViewFilter>('important')");
    expect(panel).toContain("{ value: 'tool', label: '工具' }");
    expect(panel).toContain("{ value: 'network', label: '网络' }");
    expect(panel).toContain('coalesceTraceLogs(');
    expect(styles).toMatch(/\.logs-toolbar\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto;/);
    expect(styles).toMatch(/\.log-row\s*\{[^}]*grid-template-columns:\s*70px 15px 48px minmax\(0, 1fr\) auto;/);
    expect(styles).toMatch(/\.logs-list\s*\{[^}]*overflow:\s*auto;/);
  });
});
