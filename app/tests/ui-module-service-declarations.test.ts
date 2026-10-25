import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('declares the services used by every module and its button handlers', async () => {
  const root = join(process.cwd(), 'src/renderer/src/modules');
  async function sources(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map(entry => entry.isDirectory()
      ? sources(join(directory, entry.name))
      : Promise.resolve(/\.tsx?$/.test(entry.name) ? [join(directory, entry.name)] : [])))).flat();
  }
  const missing: string[] = [];
  for (const module of await readdir(root, { withFileTypes: true })) {
    if (!module.isDirectory()) continue;
    const files = await sources(join(root, module.name));
    const used = new Set<string>(), declared = new Set<string>();
    for (const file of files) {
      const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node): void {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'services') used.add(node.name.text);
        if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'consumes' && ts.isArrayLiteralExpression(node.initializer)) {
          for (const item of node.initializer.elements) if (ts.isStringLiteral(item)) declared.add(item.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    for (const service of used) if (!declared.has(service)) missing.push(`${module.name}: ${service}`);
  }
  expect(missing).toEqual([]);
});
