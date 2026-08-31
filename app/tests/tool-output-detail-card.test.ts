import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ProtectedResultBody } from '../src/renderer/src/modules/tool-output/ToolOutputPanel';

describe('protected Tool result detail cards', () => {
  it('renders read, search, diff, and terminal results as dedicated details', () => {
    const read = render('file_read', { path: 'src/read.ts', content: 'export const read = true' });
    const search = render('file_search', {
      matches: [{ path: 'src/search.ts', line: 8, column: 3, preview: 'needle here' }]
    });
    const diff = render('file_change', {
      path: 'src/change.ts',
      diff: '--- a/src/change.ts\n+++ b/src/change.ts\n-old\n+new\n'
    });
    const terminal = render('terminal', {
      chunks: [
        { cursor: 0, channel: 'stdout', text: 'ready\n' },
        { cursor: 6, channel: 'stdout', text: 'done\n' }
      ]
    });

    expect(read).toContain('src/read.ts');
    expect(read).toContain('export const read = true');
    expect(search).toContain('src/search.ts:8:3');
    expect(search).toContain('needle here');
    expect(diff).toContain('tool-result-diff');
    expect(diff).toContain('+new');
    expect(terminal).toContain('ready\ndone');
  });
});

function render(
  kind: Parameters<typeof ProtectedResultBody>[0]['kind'],
  value: unknown
): string {
  return renderToStaticMarkup(createElement(ProtectedResultBody, {
    kind,
    value,
    raw: JSON.stringify(value)
  }));
}
