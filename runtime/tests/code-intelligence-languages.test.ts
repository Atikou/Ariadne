import { describe, expect, it } from "vitest";

import { CodeIntelligenceService } from "../src/context/CodeIntelligenceService.js";
import { LspCodeIntelligenceProvider } from "../src/context/LspCodeIntelligenceProvider.js";
import { TreeSitterWasmIntelligenceProvider } from "../src/context/TreeSitterWasmIntelligenceProvider.js";

describe("CodeIntelligenceService built-in language fixtures", () => {
  const fixtures = [
    ["fixture.ts", "export class TypeScriptService {}", "TypeScriptService"],
    ["fixture.js", "export function javascriptFeature() {}", "javascriptFeature"],
    ["fixture.json", '{"projectName":"Ariadne"}', "projectName"],
    ["fixture.md", "# Architecture\n\n## Runtime", "Architecture"],
    ["fixture.py", "class PythonService:\n    pass", "PythonService"],
    ["fixture.cs", "public class CSharpService { public void Run() {} }", "CSharpService"],
  ] as const;

  it.each(fixtures)("extracts symbols from %s", async (filePath, content, symbol) => {
    const analysis = await new CodeIntelligenceService().analyzeContent(filePath, content);
    expect(analysis.providerId).toContain("tree-sitter-wasm");
    expect(analysis.symbols).toContainEqual(expect.objectContaining({ symbol }));
  });

  it("returns explicit parse diagnostics for invalid syntax", async () => {
    const analysis = await new CodeIntelligenceService().analyzeContent(
      "broken.py",
      "def broken(:\n  pass",
    );
    expect(analysis.parseDiagnostics.length).toBeGreaterThan(0);
  });

  it("uses a configured LSP 3.18 provider before Tree-sitter", async () => {
    const lsp = new LspCodeIntelligenceProvider({
      id: "fake-python",
      command: "not-started",
      extensions: [".py"],
      languageIdByExtension: { ".py": "python" },
    }, {
      async analyze(input) {
        return {
          symbols: [{
            filePath: input.filePath,
            symbol: "FromLsp",
            kind: "lsp:class",
            line: 1,
          }],
          diagnostics: ["1:fixture diagnostic"],
        };
      },
    });
    const analysis = await new CodeIntelligenceService([
      lsp,
      new TreeSitterWasmIntelligenceProvider(),
    ]).analyzeContent("fixture.py", "class FromTree: pass", { workspaceRoot: process.cwd() });

    expect(analysis.providerId).toBe("lsp-3.18:fake-python");
    expect(analysis.symbols[0]?.symbol).toBe("FromLsp");
    expect(analysis.parseDiagnostics).toEqual(["1:fixture diagnostic"]);
  });

  it("falls back to Tree-sitter when the configured LSP fails", async () => {
    const lsp = new LspCodeIntelligenceProvider({
      id: "failing",
      command: "not-started",
      extensions: [".py"],
      languageIdByExtension: { ".py": "python" },
    }, {
      async analyze() { throw new Error("server failed"); },
    });
    const analysis = await new CodeIntelligenceService([
      lsp,
      new TreeSitterWasmIntelligenceProvider(),
    ]).analyzeContent("fixture.py", "class FromTree:\n  pass", { workspaceRoot: process.cwd() });

    expect(analysis.providerId).toBe("tree-sitter-wasm");
    expect(analysis.symbols[0]?.symbol).toBe("FromTree");
  });
});
