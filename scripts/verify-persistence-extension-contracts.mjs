import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { persistenceContractShape } from './persistence-contract-shape.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const groups = [
  { version: 1, baseline: 'persistence-extension-contracts-v1.json', initialize: '--initialize', name: 'extension',
    policy: 'Explicit versioned replacements; released V1 contracts remain unchanged. Ingress validates replay settlements and projection pages retain strict public DTO validation.',
    entries: [
      ['runtimeCommandV2', 'runtime/src/control/ports/RuntimeCommandJournalV2.ts', 'RuntimeCommandJournalV2'],
      ['publicProjectionPagedReadV1', 'runtime/src/projection/PublicProjectionPagedQueryPortsV1.ts', 'PublicProjectionPagedQueryStoreV1']
    ], message: '2 versioned contracts verified.' },
  { version: 1, baseline: 'persistence-scoped-read-contract-v1.json', initialize: '--initialize-scoped', name: 'scoped',
    entries: [['publicProjectionScopedReadV1', 'runtime/src/projection/PublicProjectionScopedQueryPortsV1.ts', 'PublicProjectionScopedQueryStoreV1']],
    message: 'scoped read V1 verified.' },
  { version: 2, baseline: 'persistence-projection-view-contract-v2.json', initialize: '--initialize-view', name: 'view',
    entries: [['publicProjectionViewReadV2', 'runtime/src/projection/PublicProjectionViewQueryPortsV2.ts', 'PublicProjectionViewQueryStoreV2']],
    message: 'view read V2 verified.' },
  { version: 3, baseline: 'persistence-projection-catalog-contract-v3.json', initialize: '--initialize-catalog', name: 'catalog',
    entries: [['publicProjectionCatalogReadV3', 'runtime/src/projection/PublicProjectionCatalogQueryPortsV3.ts', 'PublicProjectionCatalogQueryStoreV3']],
    message: 'catalog read V3 verified.' },
  { version: 1, baseline: 'persistence-feature-window-contract-v1.json', initialize: '--initialize-feature-window', name: 'feature-window',
    entries: [['publicProjectionFeatureWindowV1', 'runtime/src/projection/PublicProjectionFeatureWindowQueryPortsV1.ts', 'PublicProjectionFeatureWindowQueryStoreV1']],
    message: 'feature window V1 verified.' },
  { version: 1, baseline: 'persistence-productivity-task-isolation-v1.json', initialize: '--initialize-task-isolation', name: 'productivity-task-isolation',
    policy: 'Same Productivity owner and Schema 3; task metadata and staged recovery receipts are separate extensions. Existing nine access contracts, six extensions and original task/command records remain unchanged.',
    entries: [
      ['productivityTaskIsolationV1', 'runtime/src/control/ports/ProductivityTaskIsolationV1.ts', 'ProductivityTaskIsolationV1'],
      ['productivityTaskRecoveryAuthorityV1', 'runtime/src/control/ports/ProductivityTaskRecoveryAuthorityV1.ts', 'ProductivityTaskRecoveryAuthorityV1']
    ], message: 'task isolation/recovery V1 verified.' },
  { version: 1, baseline: 'persistence-productivity-task-recovery-query-v1.json', initialize: '--initialize-task-recovery-query', name: 'productivity-task-recovery-query',
    entries: [['productivityTaskRecoveryQueryV1', 'runtime/src/control/ports/ProductivityTaskRecoveryQueryV1.ts', 'ProductivityTaskRecoveryQueryV1']],
    message: 'task recovery query V1 verified.' },
  { version: 1, baseline: 'persistence-task-center-read-contract-v1.json', initialize: '--initialize-task-center-read', name: 'task-center-read',
    policy: 'Read-only metadata and versioned relations under original Productivity and Conversation owners; nine original ports and all previous extension baselines remain unchanged. No authoritative task state or message body in the directory.',
    entries: [
      ['productivityTaskCatalogReadV1', 'runtime/src/control/ports/ProductivityTaskCatalogReadV1.ts', 'ProductivityTaskCatalogReadV1'],
      ['conversationMessageIdentityReadV1', 'runtime/src/control/ports/ConversationMessageIdentityReadV1.ts', 'ConversationMessageIdentityReadV1']
    ], message: 'task center Source read V1 verified.' }
];
const config = ts.readConfigFile(path.join(root, 'runtime/tsconfig.json'), ts.sys.readFile);
if (config.error) throw new Error('extension_contract_config_invalid');
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.join(root, 'runtime'));
const program = ts.createProgram([...new Set([...parsed.fileNames,
  ...groups.flatMap(group => group.entries.map(([, file]) => path.join(root, file)))])], parsed.options);
const checker = program.getTypeChecker();
for (const group of groups) {
  const actual = { contractVersion: group.version, ...(group.policy === undefined ? {} : { policy: group.policy }),
    contracts: group.entries.map(([owner, file, name]) => {
      const source = program.getSourceFile(path.join(root, file));
      const module = source && checker.getSymbolAtLocation(source);
      const symbol = module && checker.getExportsOfModule(module).find(value => value.name === name);
      if (!symbol) throw new Error(`extension_contract_export_missing:${owner}`);
      const result = persistenceContractShape(checker, checker.getDeclaredTypeOfSymbol(symbol));
      return { owner, file, export: name, digest: result.digest, graphNodes: result.graph.nodes.length };
    }) };
  const baseline = path.join(root, 'runtime/config', group.baseline);
  if (process.argv.includes(group.initialize)) {
    if (existsSync(baseline)) throw new Error(`${group.name}_contract_baseline_already_exists`);
    writeFileSync(baseline, JSON.stringify(actual, null, 2) + '\n', { flag: 'wx' });
  } else if (JSON.stringify(JSON.parse(readFileSync(baseline, 'utf8'))) !== JSON.stringify(actual)) {
    throw new Error(`persistence_${group.name}_contract_changed:add_an_explicit_versioned_replacement`);
  }
  console.log(`Persistence extensions: ${group.message}`);
}
