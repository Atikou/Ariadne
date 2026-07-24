import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const remarkPlugins = [remarkGfm];

const markdownComponents: Components = {
  a({ children, href }) {
    if (!href) return <span>{children}</span>;
    return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
  },
  img({ alt }) {
    return <span className="markdown-image-placeholder">[图片：{alt?.trim() || '未命名'}]</span>;
  }
};

export interface MarkdownMessageProps {
  markdown: string;
}

export function MarkdownMessage({ markdown }: MarkdownMessageProps): React.JSX.Element {
  return (
    <div className="message-content markdown-content">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={remarkPlugins}
        skipHtml
        urlTransform={safeMarkdownUrl}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

export function safeMarkdownUrl(url: string): string {
  const candidate = url.trim();
  if (!candidate) return '';
  if (candidate.startsWith('#')) return candidate;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:'
      ? candidate
      : '';
  } catch {
    return '';
  }
}
