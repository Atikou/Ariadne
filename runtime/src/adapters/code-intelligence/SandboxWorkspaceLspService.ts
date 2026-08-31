import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type {
  AgentProcessLease,
  AgentProcessSandbox
} from '../../control/ports/AgentProcessSandbox.js';

const require = createRequire(import.meta.url);
const MAX_RESULT_ITEMS = 200;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_STDIN_CHUNK_BYTES = 64 * 1024;

export type WorkspaceLspOperation =
  | 'definition'
  | 'references'
  | 'hover'
  | 'document_symbols';

export interface WorkspaceLspQuery {
  readonly operation: WorkspaceLspOperation;
  readonly absolutePath: string;
  readonly line?: number;
  readonly column?: number;
  readonly content: string;
  readonly signal: AbortSignal;
}

export interface WorkspaceLspService {
  query(workspaceRoot: string, input: WorkspaceLspQuery): Promise<AgentToolJsonValue>;
  close(): Promise<void>;
}

/** Persistent, sandboxed LSP 3.18 owner for TypeScript and JavaScript workspaces. */
export class SandboxWorkspaceLspService implements WorkspaceLspService {
  private readonly clients = new Map<string, SandboxLspClient>();

  public constructor(
    private readonly sandboxForWorkspace: (workspaceRoot: string) => AgentProcessSandbox,
    private readonly server = bundledTypeScriptLanguageServer()
  ) {}

  public query(workspaceRoot: string, input: WorkspaceLspQuery): Promise<AgentToolJsonValue> {
    const root = path.resolve(workspaceRoot);
    let client = this.clients.get(root);
    if (client === undefined) {
      client = new SandboxLspClient(root, this.sandboxForWorkspace(root), this.server);
      this.clients.set(root, client);
    }
    return client.query(input);
  }

  public async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map((client) => client.close()));
  }
}

export interface BundledLspServer {
  readonly executable: string;
  readonly args: readonly string[];
  readonly tsserverPath: string;
}

class SandboxLspClient {
  private lease: AgentProcessLease | undefined;
  private initialized: Promise<void> | undefined;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly documentVersions = new Map<string, number>();
  private readonly pending = new Map<number, {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
    readonly removeAbort?: () => void;
  }>();

  public constructor(
    private readonly workspaceRoot: string,
    private readonly sandbox: AgentProcessSandbox,
    private readonly server: BundledLspServer
  ) {}

  public query(input: WorkspaceLspQuery): Promise<AgentToolJsonValue> {
    const operation = this.tail.then(() => this.queryInsideQueue(input));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.lease !== undefined) {
        const lease = this.lease;
        await this.request('shutdown', null, new AbortController().signal);
        await this.notify('exit', null);
        await lease.endStdin();
        await lease.completion;
      }
    } catch {
      await this.lease?.signal('terminate').catch(() => undefined);
    } finally {
      this.closed = true;
      this.failAll(new Error('workspace_lsp_closed'));
      this.lease?.cancel();
      this.lease = undefined;
    }
  }

  private async queryInsideQueue(input: WorkspaceLspQuery): Promise<AgentToolJsonValue> {
    input.signal.throwIfAborted();
    const absolutePath = assertContainedFile(this.workspaceRoot, input.absolutePath);
    const languageId = languageIdFor(absolutePath);
    await (this.initialized ??= this.initialize());
    const uri = pathToFileURL(absolutePath).href;
    const version = (this.documentVersions.get(uri) ?? 0) + 1;
    const first = !this.documentVersions.has(uri);
    this.documentVersions.set(uri, version);
    await this.notify(first ? 'textDocument/didOpen' : 'textDocument/didChange', first
      ? { textDocument: { uri, languageId, version, text: input.content } }
      : { textDocument: { uri, version }, contentChanges: [{ text: input.content }] });
    const params = input.operation === 'document_symbols'
      ? { textDocument: { uri } }
      : {
          textDocument: { uri },
          position: {
            line: requiredPosition(input.line, 'line') - 1,
            character: requiredPosition(input.column, 'column') - 1
          },
          ...(input.operation === 'references'
            ? { context: { includeDeclaration: true } }
            : {})
        };
    const method = {
      definition: 'textDocument/definition',
      references: 'textDocument/references',
      hover: 'textDocument/hover',
      document_symbols: 'textDocument/documentSymbol'
    }[input.operation];
    const raw = await this.request(method, params, input.signal);
    return normalizeLspResult(this.workspaceRoot, input.operation, raw);
  }

  private async initialize(): Promise<void> {
    this.openLease();
    await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'Ariadne Runtime', version: '3' },
      locale: 'zh-CN',
      rootUri: pathToFileURL(this.workspaceRoot).href,
      workspaceFolders: [{
        uri: pathToFileURL(this.workspaceRoot).href,
        name: path.basename(this.workspaceRoot)
      }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true }
        },
        workspace: { workspaceFolders: true }
      },
      initializationOptions: { tsserver: { path: this.server.tsserverPath } }
    }, new AbortController().signal);
    await this.notify('initialized', {});
  }

  private openLease(): void {
    if (this.closed) throw new Error('workspace_lsp_closed');
    if (this.lease !== undefined) return;
    const lease = this.sandbox.openFileLease({
      file: this.server.executable,
      args: [...this.server.args],
      cwd: this.workspaceRoot,
      workspaceRoot: this.workspaceRoot,
      mode: 'read-only',
      networkMode: 'offline',
      timeoutMs: 24 * 60 * 60_000,
      maxOutputBytes: 64 * 1024 * 1024
    }, {
      onStdout: (chunk) => this.consume(chunk),
      onStderr: () => undefined
    });
    this.lease = lease;
    void lease.completion.then((result) => {
      if (!this.closed) {
        this.failAll(new Error(
          `workspace_lsp_server_exit:${result.errorCode ?? result.exitCode ?? 'unknown'}`
        ));
      }
    }, (error: unknown) => this.failAll(asError(error)));
  }

  private request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`workspace_lsp_request_timeout:${method}`));
      }, REQUEST_TIMEOUT_MS);
      timer.unref?.();
      const abort = (): void => {
        void this.notify('$/cancelRequest', { id });
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(asError(signal.reason ?? new Error('workspace_lsp_request_aborted')));
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        removeAbort: () => signal.removeEventListener('abort', abort)
      });
      void this.send({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.removeAbort?.();
        reject(asError(error));
      });
    });
  }

  private notify(method: string, params: unknown): Promise<void> {
    return this.send({ jsonrpc: '2.0', method, params });
  }

  private async send(message: unknown): Promise<void> {
    this.openLease();
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    const bytes = Buffer.concat([
      Buffer.from(`Content-Length: ${String(body.byteLength)}\r\n\r\n`, 'ascii'),
      body
    ]);
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_STDIN_CHUNK_BYTES) {
      await this.lease!.writeStdin(bytes.subarray(
        offset,
        Math.min(bytes.byteLength, offset + MAX_STDIN_CHUNK_BYTES)
      ));
    }
  }

  private consume(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (true) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return;
        const header = this.buffer.subarray(0, headerEnd).toString('ascii');
        const rawLength = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header)?.[1];
        if (rawLength === undefined) throw new Error('workspace_lsp_content_length_invalid');
        const length = Number(rawLength);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (this.buffer.byteLength < bodyEnd) return;
        const message = JSON.parse(
          this.buffer.subarray(bodyStart, bodyEnd).toString('utf8')
        ) as Record<string, unknown>;
        this.buffer = this.buffer.subarray(bodyEnd);
        this.handle(message);
      }
    } catch (error) {
      this.failAll(asError(error));
      void this.lease?.signal('kill').catch(() => undefined);
    }
  }

  private handle(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    if (message.error !== undefined) pending.reject(new Error('workspace_lsp_request_failed'));
    else pending.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(error);
    }
    this.pending.clear();
    this.buffer = Buffer.alloc(0);
    this.documentVersions.clear();
    this.initialized = undefined;
    this.lease = undefined;
  }
}

function bundledTypeScriptLanguageServer(): BundledLspServer {
  const serverPackage = require.resolve('typescript-language-server/package.json');
  const serverCli = path.join(path.dirname(serverPackage), 'lib', 'cli.mjs');
  const tsserver = require.resolve('typescript/lib/tsserver.js');
  return {
    executable: process.execPath,
    args: [serverCli, '--stdio', '--log-level', '1'],
    tsserverPath: tsserver
  };
}

function languageIdFor(absolutePath: string): string {
  const extension = path.extname(absolutePath).toLowerCase();
  const languageId = new Map([
    ['.ts', 'typescript'],
    ['.tsx', 'typescriptreact'],
    ['.js', 'javascript'],
    ['.jsx', 'javascriptreact'],
    ['.mjs', 'javascript'],
    ['.cjs', 'javascript']
  ]).get(extension);
  if (languageId === undefined) throw new Error('workspace_lsp_language_unsupported');
  return languageId;
}

function assertContainedFile(workspaceRoot: string, absolutePath: string): string {
  const resolved = path.resolve(absolutePath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('workspace_lsp_path_outside_root');
  }
  return resolved;
}

function requiredPosition(value: number | undefined, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`workspace_lsp_${field}_invalid`);
  }
  return Number(value);
}

function normalizeLspResult(
  workspaceRoot: string,
  operation: WorkspaceLspOperation,
  raw: unknown
): AgentToolJsonValue {
  if (operation === 'hover') {
    const hover = isRecord(raw) ? raw : {};
    return {
      operation,
      content: boundedHoverText(hover.contents),
      ...(isRange(hover.range) ? { range: normalizeRange(hover.range) } : {})
    };
  }
  if (operation === 'document_symbols') {
    return { operation, items: flattenSymbols(raw).slice(0, MAX_RESULT_ITEMS) };
  }
  const values = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const items = values.flatMap((value) => normalizeLocation(workspaceRoot, value));
  return { operation, items: items.slice(0, MAX_RESULT_ITEMS), truncated: items.length > MAX_RESULT_ITEMS };
}

function normalizeLocation(workspaceRoot: string, value: unknown): AgentToolJsonValue[] {
  if (!isRecord(value)) return [];
  const uri = typeof value.uri === 'string'
    ? value.uri
    : typeof value.targetUri === 'string'
      ? value.targetUri
      : null;
  const range = isRange(value.range)
    ? value.range
    : isRange(value.targetSelectionRange)
      ? value.targetSelectionRange
      : null;
  if (uri === null || range === null || !uri.startsWith('file:')) return [];
  let absolutePath: string;
  try {
    absolutePath = fileURLToPath(uri);
  } catch {
    return [];
  }
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return [];
  }
  return [{ path: relative.replaceAll('\\', '/'), range: normalizeRange(range) }];
}

function flattenSymbols(raw: unknown): AgentToolJsonValue[] {
  if (!Array.isArray(raw)) return [];
  const items: AgentToolJsonValue[] = [];
  const visit = (value: unknown, container?: string): void => {
    if (!isRecord(value) || typeof value.name !== 'string') return;
    const range = isRange(value.selectionRange)
      ? value.selectionRange
      : isRange(value.range)
        ? value.range
        : null;
    if (range !== null) {
      items.push({
        name: value.name.slice(0, 512),
        kind: typeof value.kind === 'number' ? value.kind : 0,
        ...(container === undefined ? {} : { container }),
        range: normalizeRange(range)
      });
    }
    if (Array.isArray(value.children)) {
      for (const child of value.children) visit(child, value.name.slice(0, 512));
    }
  };
  for (const value of raw) visit(value);
  return items;
}

function boundedHoverText(value: unknown): string {
  const texts: string[] = [];
  const visit = (item: unknown): void => {
    if (typeof item === 'string') texts.push(item);
    else if (isRecord(item) && typeof item.value === 'string') texts.push(item.value);
    else if (Array.isArray(item)) for (const child of item) visit(child);
  };
  visit(value);
  return texts.join('\n\n').slice(0, 32 * 1024);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRange(value: unknown): value is {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
} {
  if (!isRecord(value) || !isRecord(value.start) || !isRecord(value.end)) return false;
  return [value.start.line, value.start.character, value.end.line, value.end.character]
    .every((part) => Number.isSafeInteger(part) && Number(part) >= 0);
}

function normalizeRange(range: {
  readonly start: { readonly line: number; readonly character: number };
  readonly end: { readonly line: number; readonly character: number };
}): AgentToolJsonValue {
  return {
    start: { line: range.start.line + 1, column: range.start.character + 1 },
    end: { line: range.end.line + 1, column: range.end.character + 1 }
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
