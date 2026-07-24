import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownMessage, safeMarkdownUrl } from '../src/renderer/src/modules/chat/MarkdownMessage';

describe('assistant Markdown messages', () => {
  it('uses a dedicated black foreground in the light theme', () => {
    const css = readFileSync(
      new URL('../src/renderer/src/app/styles.css', import.meta.url),
      'utf8'
    );

    expect(css).toContain('--assistant-message-text: #111318;');
    expect(css).toMatch(/\.markdown-content\s*\{[^}]*color:\s*var\(--assistant-message-text\)/s);
  });

  it('renders GFM headings, lists, tables and fenced code', () => {
    const markdown = [
      '# 实现方案',
      '',
      '- 支持列表',
      '- 支持表格',
      '',
      '| 能力 | 状态 |',
      '| --- | --- |',
      '| Markdown | 完成 |',
      '',
      '```ts',
      'const ready = true;',
      '```'
    ].join('\n');

    const html = renderToStaticMarkup(createElement(MarkdownMessage, { markdown }));

    expect(html).toContain('<h1>实现方案</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<table>');
    expect(html).toContain('<code class="language-ts">const ready = true;');
  });

  it('drops raw HTML, remote images and dangerous link protocols', () => {
    const markdown = [
      '<script>alert(1)</script>',
      '[危险链接](javascript:alert(1))',
      '![追踪图](https://tracker.invalid/pixel.png)'
    ].join('\n\n');

    const html = renderToStaticMarkup(createElement(MarkdownMessage, { markdown }));

    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('[图片：追踪图]');
  });

  it('allows only explicit web, mail and fragment links', () => {
    expect(safeMarkdownUrl('https://example.com/path')).toBe('https://example.com/path');
    expect(safeMarkdownUrl('http://example.com')).toBe('http://example.com');
    expect(safeMarkdownUrl('mailto:user@example.com')).toBe('mailto:user@example.com');
    expect(safeMarkdownUrl('#section')).toBe('#section');
    expect(safeMarkdownUrl('file:///C:/secret.txt')).toBe('');
    expect(safeMarkdownUrl('javascript:alert(1)')).toBe('');
    expect(safeMarkdownUrl('./relative-file')).toBe('');
  });

  it('renders an incomplete streaming code fence without throwing', () => {
    const html = renderToStaticMarkup(createElement(MarkdownMessage, {
      markdown: '正在生成：\n```ts\nconst partial ='
    }));

    expect(html).toContain('const partial =');
  });
});
