import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SandboxWorkspaceLspService } from '../src/adapters/code-intelligence/SandboxWorkspaceLspService.js';
import type {
  AgentProcessRequest,
  AgentProcessSandbox
} from '../src/control/ports/AgentProcessSandbox.js';
import { HostProcessSandbox } from '../src/sandbox/HostProcessSandbox.js';

describe('SandboxWorkspaceLspService integration', () => {
  it('keeps a real bundled TypeScript language server alive for symbols and navigation', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ariadne-workspace-lsp-'));
    const source = path.join(root, 'sample.ts');
    const content = [
      'interface Item { value: string }',
      "const item: Item = { value: 'ok' }",
      'function read(input: Item): string { return input.value }',
      'export const output = read(item)',
      ''
    ].join('\n');
    writeFileSync(source, content, 'utf8');
    const service = new SandboxWorkspaceLspService(() => hostSandbox());
    const signal = new AbortController().signal;

    try {
      const symbols = await service.query(root, {
        operation: 'document_symbols',
        absolutePath: source,
        content,
        signal
      });
      const definition = await service.query(root, {
        operation: 'definition',
        absolutePath: source,
        line: 2,
        column: 13,
        content,
        signal
      });
      const references = await service.query(root, {
        operation: 'references',
        absolutePath: source,
        line: 1,
        column: 11,
        content,
        signal
      });
      const hover = await service.query(root, {
        operation: 'hover',
        absolutePath: source,
        line: 4,
        column: 23,
        content,
        signal
      });

      expect(symbols).toMatchObject({
        operation: 'document_symbols',
        items: expect.arrayContaining([expect.objectContaining({ name: 'Item' })])
      });
      expect(definition).toMatchObject({
        operation: 'definition',
        items: [expect.objectContaining({ path: 'sample.ts' })]
      });
      expect(references).toMatchObject({
        operation: 'references',
        items: expect.arrayContaining([expect.objectContaining({ path: 'sample.ts' })])
      });
      expect(hover).toMatchObject({
        operation: 'hover',
        content: expect.stringContaining('read')
      });
    } finally {
      await service.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function hostSandbox(): AgentProcessSandbox {
  const host = new HostProcessSandbox();
  const danger = (request: AgentProcessRequest): AgentProcessRequest => ({
    ...request,
    mode: 'danger-full-access'
  });
  return {
    mode: 'danger-full-access',
    runFile: (request) => host.runFile(danger(request)),
    openFileLease: (request, observer) => host.openFileLease(danger(request), observer)
  };
}
