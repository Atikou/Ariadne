import path from "node:path";

export type ImportKind = "esm" | "require" | "export_from" | "side_effect" | "dynamic";

export interface ImportRecord {
  fromPath: string;
  importSpec: string;
  resolvedPath?: string;
  kind: ImportKind;
  line: number;
}

export type ExportKind = "named" | "default" | "reexport" | "namespace";

export interface ExportRecord {
  filePath: string;
  exportName: string;
  kind: ExportKind;
  line: number;
}

const IMPORT_FROM_RE =
  /^\s*import\s+(?:type\s+)?(?:[\w*{}\s,]+)\s+from\s+["']([^"']+)["']/;

const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+["']([^"']+)["']/;

const EXPORT_FROM_RE = /^\s*export\s+(?:type\s+)?(?:[\w*{}\s,]+)\s+from\s+["']([^"']+)["']/;

const REQUIRE_RE = /require\s*\(\s*["']([^"']+)["']\s*\)/;

const DYNAMIC_IMPORT_RE = /import\s*\(\s*["']([^"']+)["']\s*\)/;

const NAMED_EXPORT_RE =
  /^\s*export\s+(?:async\s+)?(class|function|interface|type|const|enum)\s+([A-Za-z0-9_]+)/;

const DEFAULT_EXPORT_RE =
  /^\s*export\s+default\s+(?:class|function|async\s+function|[A-Za-z0-9_]+)/;

export function extractImportsFromContent(filePath: string, content: string): ImportRecord[] {
  const imports: ImportRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const exportFrom = line.match(EXPORT_FROM_RE);
    if (exportFrom) {
      imports.push({
        fromPath: filePath,
        importSpec: exportFrom[1]!,
        kind: "export_from",
        line: i + 1,
      });
      continue;
    }
    const esm = line.match(IMPORT_FROM_RE);
    if (esm) {
      imports.push({
        fromPath: filePath,
        importSpec: esm[1]!,
        kind: "esm",
        line: i + 1,
      });
      continue;
    }
    const sideEffect = line.match(SIDE_EFFECT_IMPORT_RE);
    if (sideEffect) {
      imports.push({
        fromPath: filePath,
        importSpec: sideEffect[1]!,
        kind: "side_effect",
        line: i + 1,
      });
      continue;
    }
    const req = line.match(REQUIRE_RE);
    if (req) {
      imports.push({
        fromPath: filePath,
        importSpec: req[1]!,
        kind: "require",
        line: i + 1,
      });
      continue;
    }
    const dynamic = line.match(DYNAMIC_IMPORT_RE);
    if (dynamic) {
      imports.push({
        fromPath: filePath,
        importSpec: dynamic[1]!,
        kind: "dynamic",
        line: i + 1,
      });
    }
  }
  return imports;
}

export function extractExportsFromContent(filePath: string, content: string): ExportRecord[] {
  const exports: ExportRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const exportFrom = line.match(EXPORT_FROM_RE);
    if (exportFrom) {
      exports.push({
        filePath,
        exportName: exportFrom[1]!,
        kind: "reexport",
        line: i + 1,
      });
      continue;
    }
    const named = line.match(NAMED_EXPORT_RE);
    if (named) {
      exports.push({
        filePath,
        exportName: named[2]!,
        kind: "named",
        line: i + 1,
      });
      continue;
    }
    if (DEFAULT_EXPORT_RE.test(line)) {
      exports.push({
        filePath,
        exportName: "default",
        kind: "default",
        line: i + 1,
      });
    }
  }
  return exports;
}

/** 将相对 import 解析为工作区内已知路径。 */
export function resolveImportSpec(
  fromPath: string,
  importSpec: string,
  knownFiles: Set<string>,
): string | undefined {
  const spec = importSpec.trim();
  if (!spec.startsWith(".")) return undefined;

  const baseDir = path.posix.dirname(fromPath.replace(/\\/g, "/"));
  const raw = path.posix.normalize(path.posix.join(baseDir, spec)).replace(/^\.\//, "");
  const candidates = [
    raw,
    `${raw}.ts`,
    `${raw}.tsx`,
    `${raw}.js`,
    `${raw}.jsx`,
    `${raw}.mjs`,
    `${raw}/index.ts`,
    `${raw}/index.tsx`,
    `${raw}/index.js`,
  ];
  for (const candidate of candidates) {
    const normalized = candidate.replace(/\\/g, "/");
    if (knownFiles.has(normalized)) return normalized;
  }
  return undefined;
}

export function attachResolvedImportPaths(
  imports: ImportRecord[],
  knownFiles: Set<string>,
): ImportRecord[] {
  return imports.map((item) => ({
    ...item,
    resolvedPath: resolveImportSpec(item.fromPath, item.importSpec, knownFiles),
  }));
}
