import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retiredFamilies = ['agent', 'app', 'assistant', 'background', 'companion', 'context', 'eval',
  'lifecycle', 'model-orchestrator', 'model-router', 'notifications', 'orchestrator', 'plan', 'run', 'subagent', 'tools'];
const retiredCli = ['main', 'storage', 'LegacyLongMemoryImport', 'import-legacy-long-memory', 'migrate-scheduler-v3'];
const retiredFiles = ['config/workspaceCatalog', 'core/correlation', 'core/index', 'core/permissions', 'core/runTypes',
  'ingress/RuntimeCommandJournal',
  'model/MetricsRegistry', 'model/ModelObservabilityContracts', 'model/prepareChatRequestForModel',
  'model/prepareRemoteChatRequest', 'model/routeOptions', 'model/taskType', 'platform/NativeDirectoryPicker',
  'platform/NativeDirectoryPickerContracts', 'platform/storageRootPolicy', 'policy/NetworkPolicy',
  'policy/PathRiskClassifier', 'policy/permissionRequestTypes', 'policy/scopedPermissionCheck',
  'policy/SessionPermissionGrants', 'policy/workspaceScopeContracts', 'policy/WorkspaceScopeManager',
  'security/EgressGate', 'trace/TraceContracts', 'trace/traceQuery', 'trace/traceReader',
  'trace/traceTimelineTypes', 'util/costBudget', 'util/injection', 'util/toolResultLayers'];
const files = directory => !existsSync(directory) ? [] : readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
export function assertRetiredRuntimeAbsent(runtimeRoot) {
for (const output of ['src', 'dist']) {
  for (const family of retiredFamilies) {
    if (files(path.join(runtimeRoot, output, family)).length) throw new Error(`retired_runtime_family_present:${output}/${family}`);
  }
  for (const entry of retiredCli) {
    if (files(path.join(runtimeRoot, output, 'cli')).some(file => path.basename(file).startsWith(entry + '.'))) {
      throw new Error(`retired_runtime_cli_present:${output}/${entry}`);
    }
  }
  for (const entry of retiredFiles) {
    if (['.ts', '.js', '.d.ts', '.js.map'].some(extension => existsSync(path.join(runtimeRoot, output, entry + extension)))) {
      throw new Error(`retired_runtime_source_present:${output}/${entry}`);
    }
  }
}
const manifest = JSON.parse(readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
for (const dependency of ['@lancedb/lancedb', 'web-tree-sitter', 'tree-sitter-wasms']) {
  if (manifest.dependencies?.[dependency]) throw new Error(`retired_runtime_dependency_present:${dependency}`);
}
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
assertRetiredRuntimeAbsent(path.join(root, 'runtime'));
console.log('Retired execution families, import CLIs and dedicated dependencies are absent from source and build.');
}
