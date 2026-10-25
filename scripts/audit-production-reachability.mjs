import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Evidence inventory: reachability is necessary evidence, never permission to delete.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const relative = value => path.relative(root, value).replaceAll('\\', '/');
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? ['node_modules', 'dist', 'out', '.git'].includes(entry.name) ? [] : walk(file)
      : /\.tsx?$/u.test(file) && !file.endsWith('.d.ts') ? [file] : [];
  });
}
const files = ['runtime/src', 'app/src', 'packages'].flatMap(directory => walk(path.join(root, directory)));
const keys = new Map(files.map(file => [file.toLowerCase(), file]));
const edges = new Map();
const dynamic = [];
const resources = [];
const unresolved = [];
function resolve(from, specifier) {
  let target;
  if (specifier.startsWith('.')) target = path.resolve(path.dirname(from), specifier);
  else if (specifier.startsWith('@ariadne/')) {
    const [name, ...subpath] = specifier.slice('@ariadne/'.length).split('/');
    target = path.join(root, 'packages', name, 'src', subpath.length ? subpath.join('/') : 'index');
  } else return null;
  const stem = target.replace(/\.js$/u, '');
  return [target, `${stem}.ts`, `${stem}.tsx`, path.join(stem, 'index.ts')]
    .map(candidate => keys.get(candidate.toLowerCase())).find(Boolean) ?? null;
}
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const targets = new Set();
  function visit(node) {
    let literal;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) literal = node.argument.literal;
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      literal = node.arguments[0];
      dynamic.push({ file: relative(file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        expression: node.getText(source), literal: !!literal && ts.isStringLiteralLike(literal) });
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL'
      && node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const specifier = node.arguments[0].text;
      if (specifier.startsWith('.')) {
        const target = resolve(file, specifier);
        resources.push({ file: relative(file), specifier, target: target ? relative(target) : null });
        if (target) targets.add(target);
      }
    }
    if (literal && ts.isStringLiteralLike(literal)) {
      const target = resolve(file, literal.text);
      if (target) targets.add(target);
      else if ((literal.text.startsWith('.') || literal.text.startsWith('@ariadne/')) && !literal.text.endsWith('.css')) unresolved.push({ file: relative(file), specifier: literal.text });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  edges.set(file, targets);
}
const runtimePackage = JSON.parse(readFileSync(path.join(root, 'runtime/package.json'), 'utf8'));
const cli = [...new Set(Object.values(runtimePackage.scripts).flatMap(command =>
  [...command.matchAll(/(?:src|dist)\/(cli\/[^\s]+)\.(?:ts|js)/gu)].map(match => `runtime/src/${match[1]}.ts`)))];
const roots = ['app/src/main/index.ts', 'runtime/src/entry/runtime-process.ts', 'runtime/src/entry/headless.ts', ...cli];
function closure(entries) {
  const reached = new Set();
  const queue = entries.map(entry => path.join(root, entry));
  while (queue.length) {
    const file = queue.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    queue.push(...edges.get(file) ?? []);
  }
  return [...reached].map(relative).sort();
}
const desktopRuntime = closure(roots.slice(0, 3));
const allSupportedEntries = closure(roots);
const runtimeFiles = files.map(relative).filter(file => file.startsWith('runtime/src/'));
const unreachable = runtimeFiles.filter(file => !allSupportedEntries.includes(file));
const report = { roots, runtimeFileCount: runtimeFiles.length,
  desktopRuntimeFileCount: desktopRuntime.filter(file => file.startsWith('runtime/')).length,
  supportedEntryFileCount: allSupportedEntries.filter(file => file.startsWith('runtime/')).length,
  desktopRuntime, allSupportedEntries, unreachable, dynamic, resources, unresolved,
  edges: Object.fromEntries([...edges].map(([file, targets]) => [relative(file), [...targets].map(relative).sort()])) };
const output = path.join(root, process.argv[2] ?? 'artifacts/todo-remediation/production-reachability.json');
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ roots, runtimeFiles: runtimeFiles.length, desktopRuntime: report.desktopRuntimeFileCount,
  supportedEntries: report.supportedEntryFileCount, unreachable: unreachable.length,
  nonliteralDynamic: dynamic.filter(item => !item.literal), unresolved, output: relative(output) }, null, 2));
