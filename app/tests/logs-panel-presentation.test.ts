import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
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

  it('clips long categories inside a separated flexible grid column', async () => {
    const styles = await readFile(join(process.cwd(), 'src', 'renderer', 'src', 'app', 'styles.css'), 'utf8');

    expect(styles).toMatch(/\.log-row\s*\{[^}]*grid-template-columns:\s*78px 15px minmax\(180px, 220px\) minmax\(0, 1fr\);/);
    expect(styles).toMatch(/\.log-row\s*\{[^}]*column-gap:\s*8px;/);
    expect(styles).toMatch(/\.log-row code\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/);
    expect(styles).toMatch(/\.log-row p\s*\{[^}]*min-width:\s*0;/);
  });
});
