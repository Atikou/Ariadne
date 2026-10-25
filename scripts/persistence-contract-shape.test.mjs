import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { persistenceContractShape } from './persistence-contract-shape.mjs';

test('fixed contracts detect nested DTO, readonly, optional and method drift but permit schema implementation changes', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ariadne-contract-shape-'));
  try {
    const dto = 'export interface Record { readonly id: string; child?: Record; }';
    const port = "import type { Record } from './dto'; export interface Store { read(id: string): Promise<readonly Record[]>; }";
    function digest(dtoText = dto, portText = port, schema = 'export const schema = 1;') {
      writeFileSync(path.join(root, 'dto.ts'), dtoText);
      writeFileSync(path.join(root, 'port.ts'), portText);
      writeFileSync(path.join(root, 'schema.ts'), schema);
      const program = ts.createProgram(['dto.ts', 'port.ts', 'schema.ts'].map(file => path.join(root, file)), { strict: true, target: ts.ScriptTarget.ES2022 });
      const checker = program.getTypeChecker();
      const module = checker.getSymbolAtLocation(program.getSourceFile(path.join(root, 'port.ts')));
      const symbol = checker.getExportsOfModule(module).find(item => item.name === 'Store');
      return persistenceContractShape(checker, checker.getDeclaredTypeOfSymbol(symbol)).digest;
    }
    const baseline = digest();
    assert.equal(digest(dto, port, 'export const schema = 99;'), baseline);
    assert.equal(digest('// comment\n' + dto, port.replace('read(id', 'read(identifier')), baseline);
    assert.notEqual(digest(dto.replace('id: string', 'id: number')), baseline);
    assert.notEqual(digest(dto.replace('readonly id', 'id')), baseline);
    assert.notEqual(digest(dto.replace('child?:', 'child:')), baseline);
    assert.notEqual(digest(dto, port.replace('readonly Record[]', 'Record[]')), baseline);
    assert.notEqual(digest(dto, port.replace('id: string', 'id?: string')), baseline);
    assert.notEqual(digest(dto, port.replace('read(', 'write(')), baseline);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
