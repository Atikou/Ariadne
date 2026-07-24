import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

import {
  extractExportsFromContent,
  extractImportsFromContent,
} from "./importExportParser.js";
import type {
  CodeAnalysis,
  CodeIntelligenceProvider,
} from "./CodeIntelligenceService.js";
import type { ProjectSymbolRecord } from "./projectIndexTypes.js";

export interface LspServerConfiguration {
  id: string;
  command: string;
  args?: string[];
  extensions: string[];
  languageIdByExtension: Record<string, string>;
  environment?: Record<string, string>;
  timeoutMs?: number;
  initializationOptions?: unknown;
}

export interface LspAnalysisTransport {
  analyze(input: {
    filePath: string;
    content: string;
    languageId: string;
    workspaceRoot: string;
  }): Promise<{ symbols: ProjectSymbolRecord[]; diagnostics: string[] }>;
  dispose?(): Promise<void>;
}

/** LSP 3.18 document-symbol client. Configured servers run before WASM fallback. */
export class LspCodeIntelligenceProvider implements CodeIntelligenceProvider {
  readonly id: string;
  private readonly extensions: Set<string>;
  private readonly clients = new Map<string, LspStdioClient>();

  constructor(
    private readonly configuration: LspServerConfiguration,
    private readonly transport?: LspAnalysisTransport,
  ) {
    this.id = `lsp-3.18:${configuration.id}`;
    this.extensions = new Set(configuration.extensions.map((extension) => extension.toLowerCase()));
  }

  supports(filePath: string): boolean {
    return this.extensions.has(path.extname(filePath).toLowerCase());
  }

  async analyze(
    filePath: string,
    content: string,
    context?: { workspaceRoot?: string },
  ): Promise<CodeAnalysis> {
    const extension = path.extname(filePath).toLowerCase();
    const languageId = this.configuration.languageIdByExtension[extension];
    if (!languageId) throw new Error(`lsp_language_id_missing:${extension}`);
    const workspaceRoot = context?.workspaceRoot;
    if (!workspaceRoot) throw new Error("lsp_workspace_root_required");
    const transport = this.transport ?? this.clientFor(workspaceRoot);
    const result = await transport.analyze({ filePath, content, languageId, workspaceRoot });
    return {
      providerId: this.id,
      symbols: result.symbols,
      imports: extractImportsFromContent(filePath, content),
      exports: extractExportsFromContent(filePath, content),
      references: [],
      parseDiagnostics: result.diagnostics,
    };
  }

  async dispose(): Promise<void> {
    await this.transport?.dispose?.();
    await Promise.all([...this.clients.values()].map((client) => client.dispose()));
    this.clients.clear();
  }

  private clientFor(workspaceRoot: string): LspStdioClient {
    const normalized = path.resolve(workspaceRoot);
    let client = this.clients.get(normalized);
    if (!client) {
      client = new LspStdioClient(this.configuration, normalized);
      this.clients.set(normalized, client);
    }
    return client;
  }
}

class LspStdioClient implements LspAnalysisTransport {
  private child?: ChildProcessWithoutNullStreams;
  private initialized?: Promise<void>;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  private readonly diagnostics = new Map<string, string[]>();
  private readonly versions = new Map<string, number>();

  constructor(
    private readonly configuration: LspServerConfiguration,
    private readonly workspaceRoot: string,
  ) {}

  async analyze(input: {
    filePath: string;
    content: string;
    languageId: string;
    workspaceRoot: string;
  }): Promise<{ symbols: ProjectSymbolRecord[]; diagnostics: string[] }> {
    await (this.initialized ??= this.initialize());
    const absolutePath = path.resolve(this.workspaceRoot, input.filePath);
    const uri = pathToFileURL(absolutePath).href;
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.notify(version === 1 ? "textDocument/didOpen" : "textDocument/didChange", version === 1
      ? { textDocument: { uri, languageId: input.languageId, version, text: input.content } }
      : { textDocument: { uri, version }, contentChanges: [{ text: input.content }] });
    const raw = await this.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });
    return {
      symbols: flattenDocumentSymbols(input.filePath, raw),
      diagnostics: this.diagnostics.get(uri) ?? [],
    };
  }

  private async initialize(): Promise<void> {
    this.ensureChild();
    await this.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "Ariadne", version: "2.0" },
      locale: "zh-CN",
      rootUri: pathToFileURL(this.workspaceRoot).href,
      capabilities: {
        textDocument: {
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
        workspace: { workspaceFolders: true },
      },
      workspaceFolders: [{
        uri: pathToFileURL(this.workspaceRoot).href,
        name: path.basename(this.workspaceRoot),
      }],
      initializationOptions: this.configuration.initializationOptions,
    });
    this.notify("initialized", {});
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;
    const child = spawn(this.configuration.command, this.configuration.args ?? [], {
      cwd: this.workspaceRoot,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        ...this.configuration.environment,
      },
    });
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", () => undefined);
    child.on("exit", () => this.failAll(new Error("lsp_server_exited")));
    child.on("error", (error) => this.failAll(error));
    this.child = child;
    return child;
  }

  async dispose(): Promise<void> {
    if (!this.child) return;
    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } catch {
      this.child.kill();
    } finally {
      this.child = undefined;
      this.initialized = undefined;
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`lsp_request_timeout:${method}`));
      }, this.configuration.timeoutMs ?? 10_000);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.ensureChild().stdin.write(
      Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]),
    );
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = /Content-Length:\s*(\d+)/iu.exec(header)?.[1];
      if (!length) return this.failAll(new Error("lsp_invalid_content_length"));
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + Number(length);
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.subarray(bodyEnd);
      this.handle(JSON.parse(body) as Record<string, unknown>);
    }
  }

  private handle(message: Record<string, unknown>): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error("lsp_request_failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params as {
        uri?: string;
        diagnostics?: Array<{ message?: string; range?: { start?: { line?: number } } }>;
      };
      if (params.uri) {
        this.diagnostics.set(params.uri, (params.diagnostics ?? []).map((diagnostic) =>
          `${(diagnostic.range?.start?.line ?? 0) + 1}:${diagnostic.message ?? "diagnostic"}`));
      }
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child = undefined;
  }
}

function flattenDocumentSymbols(filePath: string, value: unknown): ProjectSymbolRecord[] {
  if (!Array.isArray(value)) return [];
  const symbols: ProjectSymbolRecord[] = [];
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    const symbol = item as {
      name?: unknown;
      kind?: unknown;
      range?: { start?: { line?: unknown } };
      location?: { range?: { start?: { line?: unknown } } };
      children?: unknown[];
    };
    if (typeof symbol.name === "string") {
      const line = symbol.range?.start?.line ?? symbol.location?.range?.start?.line;
      symbols.push({
        filePath,
        symbol: symbol.name,
        kind: `lsp:${String(symbol.kind ?? "symbol")}`,
        line: typeof line === "number" ? line + 1 : 1,
      });
    }
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const item of value) visit(item);
  return symbols.slice(0, 500);
}
