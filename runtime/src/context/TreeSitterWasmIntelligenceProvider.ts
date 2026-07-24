import { createRequire } from "node:module";
import path from "node:path";

import Parser from "web-tree-sitter";

import {
  extractExportsFromContent,
  extractImportsFromContent,
} from "./importExportParser.js";
import type {
  CodeAnalysis,
  CodeIntelligenceProvider,
} from "./CodeIntelligenceService.js";
import type { ProjectSymbolRecord } from "./projectIndexTypes.js";

const require = createRequire(import.meta.url);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".py": "python",
  ".cs": "c_sharp",
};

const DECLARATION_TYPES = new Map<string, string>([
  ["class_declaration", "class"],
  ["class_definition", "class"],
  ["interface_declaration", "interface"],
  ["struct_declaration", "struct"],
  ["enum_declaration", "enum"],
  ["function_declaration", "function"],
  ["function_definition", "function"],
  ["method_declaration", "method"],
  ["type_alias_declaration", "type"],
  ["namespace_declaration", "namespace"],
  ["pair", "property"],
]);

export class TreeSitterWasmIntelligenceProvider implements CodeIntelligenceProvider {
  readonly id = "tree-sitter-wasm";
  private readonly languages = new Map<string, Promise<Parser.Language>>();
  private initialized?: Promise<void>;

  supports(filePath: string): boolean {
    return path.extname(filePath).toLowerCase() === ".md"
      || LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()] !== undefined;
  }

  async analyze(filePath: string, content: string): Promise<CodeAnalysis> {
    if (path.extname(filePath).toLowerCase() === ".md") {
      return markdownAnalysis(filePath, content, this.id);
    }
    const languageName = LANGUAGE_BY_EXTENSION[path.extname(filePath).toLowerCase()];
    if (!languageName) return empty(this.id);
    await (this.initialized ??= Parser.init());
    const language = await this.loadLanguage(languageName);
    const parser = new Parser();
    try {
      parser.setLanguage(language);
      const tree = parser.parse(content);
      if (!tree) throw new Error("tree_sitter_parse_returned_null");
      try {
        return {
          providerId: this.id,
          symbols: extractSymbols(filePath, tree.rootNode, content),
          imports: extractImportsFromContent(filePath, content),
          exports: extractExportsFromContent(filePath, content),
          references: extractReferences(filePath, tree.rootNode),
          parseDiagnostics: tree.rootNode.hasError()
            ? collectErrorNodes(tree.rootNode).map((node) =>
                `parse_error:${node.startPosition.row + 1}:${node.type}`)
            : [],
        };
      } finally {
        tree.delete();
      }
    } finally {
      parser.delete();
    }
  }

  private loadLanguage(name: string): Promise<Parser.Language> {
    let language = this.languages.get(name);
    if (!language) {
      const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`);
      language = Parser.Language.load(wasmPath);
      this.languages.set(name, language);
    }
    return language;
  }
}

function extractSymbols(
  filePath: string,
  root: Parser.SyntaxNode,
  content: string,
): ProjectSymbolRecord[] {
  const symbols: ProjectSymbolRecord[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    const kind = DECLARATION_TYPES.get(node.type);
    if (kind) {
      const nameNode =
        node.childForFieldName("name")
        ?? node.childForFieldName("key")
        ?? node.namedChildren.find((child) =>
          ["identifier", "property_identifier", "string"].includes(child.type));
      const symbol = nameNode?.text.replace(/^["']|["']$/gu, "");
      if (symbol) {
        symbols.push({
          filePath,
          symbol,
          kind,
          line: node.startPosition.row + 1,
        });
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return dedupe(symbols).slice(0, 500);
}

function markdownAnalysis(filePath: string, content: string, providerId: string): CodeAnalysis {
  const symbols: ProjectSymbolRecord[] = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(line);
    if (heading) {
      symbols.push({
        filePath,
        symbol: heading[2]!,
        kind: `heading${heading[1]!.length}`,
        line: index + 1,
      });
    }
  }
  return {
    providerId: `${providerId}:markdown`,
    symbols,
    imports: [],
    exports: [],
    references: [],
    parseDiagnostics: [],
  };
}

function collectErrorNodes(root: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const errors: Parser.SyntaxNode[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "ERROR" || node.isMissing()) errors.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return errors.slice(0, 50);
}

function extractReferences(
  filePath: string,
  root: Parser.SyntaxNode,
): CodeAnalysis["references"] {
  const references: CodeAnalysis["references"] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (["identifier", "type_identifier", "property_identifier"].includes(node.type)) {
      const parentName = node.parent?.childForFieldName("name");
      if (parentName?.id !== node.id) {
        references.push({
          filePath,
          symbol: node.text,
          kind: node.type,
          line: node.startPosition.row + 1,
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return references.slice(0, 1_000);
}

function dedupe(items: ProjectSymbolRecord[]): ProjectSymbolRecord[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.symbol}:${item.kind}:${item.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function empty(providerId: string): CodeAnalysis {
  return {
    providerId,
    symbols: [],
    imports: [],
    exports: [],
    references: [],
    parseDiagnostics: [],
  };
}
