import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { persistenceContractShape } from './persistence-contract-shape.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contracts = [
  ['agentControl', 'packages/agent-core/src/application/unit-of-work.ts', 'AgentRunUnitOfWork'],
  ['conversation', 'runtime/src/control/ports/ConversationAuthorityPersistence.ts', 'ConversationAuthorityUnitOfWork'],
  ['conversationHandoff', 'runtime/src/control/ports/ConversationRunHandoffPersistence.ts', 'ConversationRunHandoffUnitOfWork'],
  ['runtimeCommand', 'runtime/src/control/ports/RuntimeCommandJournal.ts', 'RuntimeCommandJournal'],
  ['publicProjectionWrite', 'runtime/src/projection/PublicProjectionPorts.ts', 'PublicProjectionCommitSink'],
  ['publicProjectionRead', 'runtime/src/projection/PublicProjectionPorts.ts', 'PublicProjectionQueryStore'],
  ['productivity', 'runtime/src/control/ports/ProductivityAuthority.ts', 'ProductivityAuthority'],
  ['modelCapability', 'runtime/src/model/capability/ModelCapabilityAuthority.ts', 'ModelCapabilityAuthority'],
  ['longMemory', 'runtime/src/control/ports/LongMemoryAuthority.ts', 'LongMemoryAuthority']
];
const config = ts.readConfigFile(path.join(root, 'runtime/tsconfig.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.join(root, 'runtime'));
const program = ts.createProgram([...new Set([...parsed.fileNames, ...contracts.map(([, file]) => path.join(root, file))])], parsed.options);
const checker = program.getTypeChecker();
const actual = { contractVersion: 2, policy: 'Existing business signatures and DTO shapes are immutable; physical schema changes use validated offline migrations.', contracts: contracts.map(([owner, file, name]) => {
  const source = program.getSourceFile(path.join(root, file));
  const module = source && checker.getSymbolAtLocation(source);
  const symbol = module && checker.getExportsOfModule(module).find(value => value.name === name);
  if (!symbol) throw new Error(`persistence_contract_export_missing:${file}:${name}`);
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  if (type.flags & ts.TypeFlags.Any) throw new Error(`persistence_contract_export_unresolved:${owner}`);
  const result = persistenceContractShape(checker, type);
  return { owner, file, export: name, digest: result.digest, graphNodes: result.graph.nodes.length };
}) };
const baseline = path.join(root, 'runtime/config/persistence-contract.json');
if (process.argv.includes('--print')) {
  console.log(JSON.stringify(actual, null, 2));
  process.exit(0);
}
if (process.argv.includes('--initialize')) {
  if (existsSync(baseline)) throw new Error('persistence_contract_baseline_already_exists:never overwrite a released contract');
  writeFileSync(baseline, JSON.stringify(actual, null, 2) + '\n');
} else {
  const expected = JSON.parse(readFileSync(baseline, 'utf8'));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    const changed = actual.contracts.filter(item => expected.contracts?.find(previous => previous.owner === item.owner)?.digest !== item.digest).map(item => item.owner);
    throw new Error(`persistence_contract_changed:${changed.join(',')}:preserve the fixed interface; add an explicitly versioned replacement only for a reviewed major redesign`);
  }
}
console.log(`Persistence contract: ${actual.contracts.length} fixed access contracts verified.`);
