import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  extractExportsFromContent,
  extractImportsFromContent,
  type ExportRecord,
  type ImportRecord,
} from "./importExportParser.js";
import type {
  ProjectReferenceRecord,
  ProjectSymbolRecord,
} from "./projectIndexTypes.js";
import { TreeSitterWasmIntelligenceProvider } from "./TreeSitterWasmIntelligenceProvider.js";

export interface CodeAnalysis {
  providerId: string;
  symbols: ProjectSymbolRecord[];
  imports: ImportRecord[];
  exports: ExportRecord[];
  references: ProjectReferenceRecord[];
  parseDiagnostics: string[];
}

export interface CodeIntelligenceProvider {
  readonly id: string;
  supports(filePath: string): boolean;
  analyze(
    filePath: string,
    content: string,
    context?: { workspaceRoot?: string },
  ): Promise<CodeAnalysis>;
  dispose?(): Promise<void>;
}

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** 统一代码理解入口；ProjectIndex 不再自行用关键词/正则猜 TS/JS 结构。 */
export class CodeIntelligenceService {
  constructor(
    private readonly providers: readonly CodeIntelligenceProvider[] = [
      new TreeSitterWasmIntelligenceProvider(),
      new TextFallbackIntelligenceProvider(),
    ],
  ) {}

  async analyzeContent(
    filePath: string,
    content: string,
    context?: { workspaceRoot?: string },
  ): Promise<CodeAnalysis> {
    const providers = this.providers.filter((candidate) => candidate.supports(filePath));
    for (const provider of providers) {
      try {
        return await provider.analyze(filePath, content, context);
      } catch {
        // A failed configured LSP provider falls through to deterministic WASM.
      }
    }
    return new TextFallbackIntelligenceProvider().analyze(filePath, content);
  }

  async analyzeFile(workspaceRoot: string, relativePath: string): Promise<CodeAnalysis> {
    const absolute = path.join(workspaceRoot, relativePath);
    try {
      const buffer = await fs.readFile(absolute);
      if (buffer.includes(0)) return emptyAnalysis("binary");
      return await this.analyzeContent(
        relativePath,
        buffer.toString("utf8").slice(0, 240_000),
        { workspaceRoot },
      );
    } catch (error) {
      return {
        ...emptyAnalysis("unreadable"),
        parseDiagnostics: [String(error)],
      };
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(this.providers.map((provider) => provider.dispose?.()));
  }
}

export class TypeScriptAstIntelligenceProvider implements CodeIntelligenceProvider {
  readonly id = "typescript-ast";

  supports(filePath: string): boolean {
    return TS_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  async analyze(filePath: string, content: string): Promise<CodeAnalysis> {
    const source = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(filePath),
    );
    const symbols: ProjectSymbolRecord[] = [];
    const imports: ImportRecord[] = [];
    const exports: ExportRecord[] = [];

    const addSymbol = (name: string | undefined, kind: string, node: ts.Node) => {
      if (!name || symbols.length >= 500) return;
      symbols.push({ filePath, symbol: name, kind, line: lineOf(source, node) });
    };
    const addExport = (name: string, kind: ExportRecord["kind"], node: ts.Node) => {
      exports.push({ filePath, exportName: name, kind, line: lineOf(source, node) });
    };

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push({
          fromPath: filePath,
          importSpec: node.moduleSpecifier.text,
          kind: node.importClause ? "esm" : "side_effect",
          line: lineOf(source, node),
        });
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push({
          fromPath: filePath,
          importSpec: node.moduleSpecifier.text,
          kind: "export_from",
          line: lineOf(source, node),
        });
        const names = node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((item) => item.name.text)
          : [node.exportClause && ts.isNamespaceExport(node.exportClause) ? node.exportClause.name.text : node.moduleSpecifier.text];
        for (const name of names) addExport(name, "reexport", node);
      } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0]!)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          imports.push({
            fromPath: filePath,
            importSpec: node.arguments[0]!.text,
            kind: "dynamic",
            line: lineOf(source, node),
          });
        } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
          imports.push({
            fromPath: filePath,
            importSpec: node.arguments[0]!.text,
            kind: "require",
            line: lineOf(source, node),
          });
        }
      }

      if (ts.isClassDeclaration(node)) declaration(node, "class");
      else if (ts.isFunctionDeclaration(node)) declaration(node, "function");
      else if (ts.isInterfaceDeclaration(node)) declaration(node, "interface");
      else if (ts.isTypeAliasDeclaration(node)) declaration(node, "type");
      else if (ts.isEnumDeclaration(node)) declaration(node, "enum");
      else if (ts.isVariableStatement(node)) {
        const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
        for (const declarationNode of node.declarationList.declarations) {
          if (!ts.isIdentifier(declarationNode.name)) continue;
          addSymbol(declarationNode.name.text, "const", declarationNode);
          if (exported) addExport(declarationNode.name.text, "named", declarationNode);
        }
      } else if (ts.isMethodDeclaration(node) && node.name) {
        addSymbol(node.name.getText(source), "method", node);
      }

      ts.forEachChild(node, visit);

      function declaration(
        declarationNode: ts.ClassDeclaration | ts.FunctionDeclaration | ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
        kind: string,
      ) {
        const name = declarationNode.name?.text;
        addSymbol(name, kind, declarationNode);
        if (hasModifier(declarationNode, ts.SyntaxKind.DefaultKeyword)) addExport("default", "default", declarationNode);
        else if (name && hasModifier(declarationNode, ts.SyntaxKind.ExportKeyword)) addExport(name, "named", declarationNode);
      }
    };
    visit(source);

    return {
      providerId: this.id,
      symbols: dedupe(symbols, (item) => `${item.symbol}:${item.line}:${item.kind}`),
      imports: dedupe(imports, (item) => `${item.importSpec}:${item.line}:${item.kind}`),
      exports: dedupe(exports, (item) => `${item.exportName}:${item.line}:${item.kind}`),
      references: extractTypeScriptReferences(source, filePath),
      parseDiagnostics: (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
    };
  }
}

export class TextFallbackIntelligenceProvider implements CodeIntelligenceProvider {
  readonly id = "text-fallback";
  supports(): boolean {
    return true;
  }
  async analyze(filePath: string, content: string): Promise<CodeAnalysis> {
    return {
      providerId: this.id,
      symbols: extractFallbackSymbols(filePath, content),
      imports: extractImportsFromContent(filePath, content),
      exports: extractExportsFromContent(filePath, content),
      references: [],
      parseDiagnostics: [],
    };
  }
}

export const defaultCodeIntelligenceService = new CodeIntelligenceService();

function scriptKindFor(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case ".tsx": return ts.ScriptKind.TSX;
    case ".jsx": return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs": return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) === true;
}

function extractFallbackSymbols(filePath: string, content: string): ProjectSymbolRecord[] {
  const symbols: ProjectSymbolRecord[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const match = line.match(/^\s*(?:export\s+)?(class|function|interface|type|const|enum)\s+([A-Za-z0-9_]+)/);
    if (match) symbols.push({ filePath, symbol: match[2]!, kind: match[1]!, line: index + 1 });
  }
  return symbols.slice(0, 200);
}

function emptyAnalysis(providerId: string): CodeAnalysis {
  return {
    providerId,
    symbols: [],
    imports: [],
    exports: [],
    references: [],
    parseDiagnostics: [],
  };
}

function extractTypeScriptReferences(
  source: ts.SourceFile,
  filePath: string,
): ProjectReferenceRecord[] {
  const references: ProjectReferenceRecord[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !isDeclarationName(node)) {
      references.push({
        filePath,
        symbol: node.text,
        kind: "identifier",
        line: lineOf(source, node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return dedupe(references, (item) => `${item.symbol}:${item.line}`).slice(0, 1_000);
}

function isDeclarationName(node: ts.Identifier): boolean {
  const parent = node.parent;
  return "name" in parent && (parent as { name?: ts.Node }).name === node;
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
