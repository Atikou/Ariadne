import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultBaselinePath = path.join(
  projectRoot,
  'docs',
  'adr',
  '0003-dependency-direction-and-baseline.md'
);
const baselineStart = '<!-- architecture-baseline:start -->';
const baselineEnd = '<!-- architecture-baseline:end -->';
const sourceExtensions = new Set(['.ts', '.tsx']);
const skippedDirectories = new Set(['.git', 'dist', 'node_modules', 'out']);
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
]);
const runtimeTargetLayers = new Set([
  'ingress',
  'control',
  'conversation',
  'projection',
  'adapters',
  'composition',
  'transport'
]);
const runtimeLayerAllowList = new Map([
  ['ingress', new Set(['ingress', 'control'])],
  ['control', new Set(['control', 'conversation'])],
  ['conversation', new Set(['conversation'])],
  ['projection', new Set(['projection', 'conversation'])],
  ['adapters', new Set(['adapters', 'conversation', 'projection'])],
  ['transport', new Set(['transport', 'ingress'])],
  ['composition', runtimeTargetLayers]
]);
const contractLayerAllowList = new Map([
  ['common', new Set(['common'])],
  ['public', new Set(['common', 'public'])],
  ['desktop', new Set(['common', 'public', 'desktop'])],
  ['settings', new Set(['common', 'settings'])],
  ['host', new Set(['common', 'public', 'desktop', 'settings', 'host'])],
  ['headless', new Set(['common', 'public', 'host', 'headless'])],
  ['index', new Set(['common', 'public', 'desktop', 'settings', 'host', 'headless', 'index'])]
]);

const options = parseOptions(process.argv.slice(2));
assertNarrowDependencyExceptions();
assertRetiredProductionChainsAbsent();
assertUiPanelsUseFeatureStores();
assertSpeechEntityBoundaries();
if (options.help) {
  printHelp();
  process.exit(0);
}

const roots = discoverSourceRoots();
const sourceFiles = roots
  .flatMap((root) => walk(root))
  .sort((left, right) => relative(left).localeCompare(relative(right)));
const sourceByKey = new Map(sourceFiles.map((file) => [pathKey(file), file]));
const parseErrors = [];
const imports = sourceFiles.flatMap((file) => parseImports(file));
const resolvedImports = imports.map((entry) => ({
  ...entry,
  target: resolveInternalImport(entry.fromAbsolute, entry.specifier)
}));
const graph = buildGraph(sourceFiles, resolvedImports);
const stronglyConnectedComponents = findStronglyConnectedComponents(graph);
const cycles = stronglyConnectedComponents
  .filter((component) => (
    component.length > 1
    || graph.get(component[0])?.has(component[0])
  ))
  .map((component) => component.map(relative).sort())
  .sort(compareStringArrays);
const cyclicEdges = findCyclicEdges(cycles, graph);
const ruleViolations = findRuleViolations(resolvedImports);
const allowedAdapterControlPortTypeImports = resolvedImports
  .filter((entry) => isAdapterControlPortTypeImport(
    classifyFile(entry.from),
    entry.target ? classifyFile(relative(entry.target)) : classifySpecifier(entry.specifier),
    entry
  ))
  .map((entry) => `${entry.from} -> ${entry.target ? relative(entry.target) : entry.specifier}`)
  .sort();
const currentBaseline = createBaseline(cycles, cyclicEdges, ruleViolations);

if (options.writeBaseline) {
  if (!options.acknowledgeCurrentDebt) {
    failUsage(
      '--write-baseline 会接受当前架构债务，必须同时传入 --acknowledge-current-debt'
    );
  }
  if (parseErrors.length > 0) {
    printParseErrors();
    process.exit(1);
  }
  writeBaseline(options.baselinePath, currentBaseline);
  process.stdout.write(
    `Architecture baseline updated: ${relative(options.baselinePath)}\n`
  );
  printSummary({
    baseline: currentBaseline,
    newCycleComponents: [],
    newCyclicEdges: [],
    newRuleViolations: [],
    resolvedCyclicEdges: [],
    resolvedRuleViolations: [],
    ok: true
  });
  process.exit(0);
}

let baseline;
try {
  baseline = options.strict
    ? emptyBaseline()
    : loadBaseline(options.baselinePath);
} catch (error) {
  process.stderr.write(`Architecture baseline error: ${toErrorMessage(error)}\n`);
  process.exit(1);
}

const comparison = compareWithBaseline(currentBaseline, baseline);
const report = {
  ok: (
    parseErrors.length === 0
    && comparison.newCycleComponents.length === 0
    && comparison.newCyclicEdges.length === 0
    && comparison.newRuleViolations.length === 0
    && comparison.resolvedCyclicEdges.length === 0
    && comparison.resolvedRuleViolations.length === 0
  ),
  scannedFileCount: sourceFiles.length,
  importCount: resolvedImports.length,
  resolvedInternalEdgeCount: [...graph.values()]
    .reduce((total, targets) => total + targets.size, 0),
  typeImportCount: resolvedImports.filter((entry) => entry.kind.includes('type')).length,
  allowedAdapterControlPortTypeImports,
  parseErrors,
  current: currentBaseline,
  baseline,
  ...comparison
};

if (options.json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printSummary(report);
  printFailures(report);
}
if (!report.ok) process.exitCode = 1;

function parseOptions(args) {
  const parsed = {
    acknowledgeCurrentDebt: false,
    baselinePath: defaultBaselinePath,
    help: false,
    json: false,
    strict: false,
    writeBaseline: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--acknowledge-current-debt') {
      parsed.acknowledgeCurrentDebt = true;
    } else if (argument === '--baseline') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) failUsage('--baseline 需要一个文件路径');
      parsed.baselinePath = path.resolve(projectRoot, value);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      parsed.help = true;
    } else if (argument === '--json') {
      parsed.json = true;
    } else if (argument === '--strict') {
      parsed.strict = true;
    } else if (argument === '--write-baseline') {
      parsed.writeBaseline = true;
    } else {
      failUsage(`未知参数：${argument}`);
    }
  }
  if (parsed.strict && parsed.writeBaseline) {
    failUsage('--strict 与 --write-baseline 不能同时使用');
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Ariadne architecture gate

Usage:
  node scripts/check-architecture.mjs
  node scripts/check-architecture.mjs --json
  node scripts/check-architecture.mjs --strict
  node scripts/check-architecture.mjs --write-baseline --acknowledge-current-debt
  node scripts/check-architecture.mjs --baseline <path>

Default mode compares current TS/TSX dependencies with the committed baseline.
Resolved debt may disappear without a baseline update. New cyclic edges, new
cycle membership, and new dependency-rule violations fail the command.
The only Runtime layer exception is a type-only import from adapters into
runtime/control/ports/**; value imports and control implementation imports fail.
\n`);
}

function failUsage(message) {
  process.stderr.write(`${message}\n使用 --help 查看命令说明。\n`);
  process.exit(2);
}

function discoverSourceRoots() {
  const candidates = [
    path.join(projectRoot, 'app', 'src'),
    path.join(projectRoot, 'runtime', 'src')
  ];
  const packagesRoot = path.join(projectRoot, 'packages');
  if (existsSync(packagesRoot)) {
    for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.push(path.join(packagesRoot, entry.name, 'src'));
    }
  }
  return candidates.filter((candidate) => existsSync(candidate));
}

function assertRetiredProductionChainsAbsent() {
  const roots = [
    path.join(projectRoot, 'app', 'src', 'main'),
    path.join(projectRoot, 'app', 'src', 'renderer'),
    path.join(projectRoot, 'runtime', 'src', 'entry'),
    path.join(projectRoot, 'runtime', 'src', 'composition'),
    path.join(projectRoot, 'runtime', 'src', 'control', 'resources'),
    path.join(projectRoot, 'runtime', 'src', 'ingress'),
    path.join(projectRoot, 'runtime', 'src', 'application', 'RuntimeKernelApplication.ts'),
    path.join(projectRoot, 'packages', 'protocol', 'src', 'host'),
    path.join(projectRoot, 'packages', 'protocol', 'src', 'public.ts')
  ];
  const forbidden = [
    'companion.sessions.',
    'companion.chat.',
    'companion.workspaces.',
    'agent.proposals.respond',
    'runs.cancel',
    'runs.recover',
    'runs.resume',
    'runActivities.get',
    'runActivityDetails.get',
    'events.replay',
    'purgeAfter',
    'purgedAt',
    'LegacyRuntimeApplication',
    'RuntimeFacade',
    'AgentProcessSessionService',
    'agent.process-sessions',
    'workspace.process-sessions',
    'background.tasks',
    'workspace.process_list',
    'workspace.process_read',
    'workspace.process_stop',
    'builtinModuleRegistry',
    'builtin-modules',
    'MODULE_IDS',
    'module-ids'
  ];
  const violations = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      for (const token of forbidden) {
        if (source.includes(token)) violations.push(`${relative(file)} -> ${token}`);
      }
    }
  }
  if (violations.length === 0) return;
  throw new Error(
    `Retired production command chain detected:\n${violations.join('\n')}`
  );
}

function assertUiPanelsUseFeatureStores() {
  const modulesRoot = path.join(projectRoot, 'app', 'src', 'renderer', 'src', 'modules');
  const violations = [];
  for (const file of walk(modulesRoot)) {
    const source = readFileSync(file, 'utf8');
    if (source.includes('services.runtime') || source.includes('useRuntimeSnapshot')) {
      violations.push(relative(file));
    }
  }
  if (violations.length === 0) return;
  throw new Error(
    `UI component bypasses declared Feature Stores:\n${violations.join('\n')}`
  );
}

function assertSpeechEntityBoundaries() {
  const application = readFileSync(path.join(projectRoot, 'app', 'src', 'main', 'application.ts'), 'utf8');
  if (application.includes('speech/speech-gateway') || /new\s+SpeechGateway\b/u.test(application)) {
    throw new Error('ApplicationController must consume the compiled Speech Entity, not SpeechGateway.');
  }
  const moduleServices = readFileSync(path.join(
    projectRoot, 'app', 'src', 'renderer', 'src', 'core', 'services', 'module-services.ts'
  ), 'utf8');
  if (/new\s+(?:SpeechCoordinator|SpeechAgentBridge)\b/u.test(moduleServices)) {
    throw new Error('ModuleServices must consume the compiled Renderer Speech Entity.');
  }
  const speechRoot = path.join(projectRoot, 'app', 'src', 'renderer', 'src', 'core', 'speech');
  const runtimeStoreImports = walk(speechRoot)
    .filter((file) => readFileSync(file, 'utf8').includes('runtime/runtime-store'))
    .map(relative);
  if (runtimeStoreImports.length > 0) {
    throw new Error(`Speech components bypass Feature Stores:\n${runtimeStoreImports.join('\n')}`);
  }
}

function walk(root) {
  if (!existsSync(root)) return [];
  const rootStat = statSync(root);
  if (rootStat.isFile()) {
    return sourceExtensions.has(path.extname(root).toLowerCase()) ? [root] : [];
  }
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(absolute));
    } else if (sourceExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(absolute);
    }
  }
  return files;
}

function parseImports(file) {
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  for (const diagnostic of sourceFile.parseDiagnostics) {
    const position = diagnostic.start === undefined
      ? undefined
      : sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
    parseErrors.push({
      file: relative(file),
      line: position === undefined ? undefined : position.line + 1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    });
  }

  const entries = [];
  const add = (specifierNode, kind) => {
    if (!specifierNode || !ts.isStringLiteralLike(specifierNode)) return;
    entries.push({
      from: relative(file),
      fromAbsolute: file,
      kind,
      specifier: specifierNode.text
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const allBindingsAreTypeOnly = Boolean(node.importClause?.isTypeOnly)
        || (
          node.importClause?.namedBindings
          && ts.isNamedImports(node.importClause.namedBindings)
          && node.importClause.namedBindings.elements.length > 0
          && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)
          && !node.importClause.name
        );
      add(node.moduleSpecifier, allBindingsAreTypeOnly ? 'static-type' : 'static-value');
    } else if (ts.isExportDeclaration(node)) {
      const allExportsAreTypeOnly = Boolean(node.isTypeOnly)
        || (
          node.exportClause
          && ts.isNamedExports(node.exportClause)
          && node.exportClause.elements.length > 0
          && node.exportClause.elements.every((element) => element.isTypeOnly)
        );
      add(node.moduleSpecifier, allExportsAreTypeOnly ? 'reexport-type' : 'reexport-value');
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression, node.isTypeOnly ? 'equals-type' : 'equals-value');
    } else if (
      ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
    ) {
      add(node.argument.literal, 'inline-type');
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
    ) {
      add(node.arguments[0], 'dynamic-literal');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return dedupeBy(entries, (entry) => `${entry.kind}\0${entry.specifier}`);
}

function resolveInternalImport(fromFile, specifier) {
  const workspaceTarget = resolveWorkspaceSpecifier(specifier);
  if (workspaceTarget) return findSourceCandidate(workspaceTarget);
  if (!specifier.startsWith('.')) return null;
  return findSourceCandidate(path.resolve(path.dirname(fromFile), specifier));
}

function resolveWorkspaceSpecifier(specifier) {
  const workspacePackages = [
    ['@ariadne/component-contracts', path.join(projectRoot, 'packages', 'component-contracts', 'src')],
    ['@ariadne/protocol', path.join(projectRoot, 'packages', 'protocol', 'src')],
    ['@ariadne/contracts', path.join(projectRoot, 'packages', 'contracts', 'src')],
    ['@ariadne/agent-core', path.join(projectRoot, 'packages', 'agent-core', 'src')],
    ['@ariadne/live-work', path.join(projectRoot, 'packages', 'live-work', 'src')],
    ['@ariadne/runtime', path.join(projectRoot, 'runtime', 'src')],
    ['@ariadne/app', path.join(projectRoot, 'app', 'src')]
  ];
  for (const [packageName, packageRoot] of workspacePackages) {
    if (specifier === packageName) return path.join(packageRoot, 'index');
    if (specifier.startsWith(`${packageName}/`)) {
      return path.join(packageRoot, specifier.slice(packageName.length + 1));
    }
  }
  return null;
}

function findSourceCandidate(target) {
  const extension = path.extname(target).toLowerCase();
  const withoutJavaScriptExtension = ['.js', '.jsx', '.mjs', '.cjs'].includes(extension)
    ? target.slice(0, -extension.length)
    : target;
  const candidates = [
    target,
    `${withoutJavaScriptExtension}.ts`,
    `${withoutJavaScriptExtension}.tsx`,
    path.join(withoutJavaScriptExtension, 'index.ts'),
    path.join(withoutJavaScriptExtension, 'index.tsx')
  ];
  for (const candidate of candidates) {
    const known = sourceByKey.get(pathKey(candidate));
    if (known) return known;
  }
  return null;
}

function buildGraph(files, importEntries) {
  const result = new Map(files.map((file) => [file, new Set()]));
  for (const entry of importEntries) {
    if (!entry.target) continue;
    result.get(entry.fromAbsolute)?.add(entry.target);
  }
  return result;
}

function findStronglyConnectedComponents(graphToInspect) {
  let nextIndex = 0;
  const indices = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];

  const connect = (node) => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graphToInspect.get(node) ?? []) {
      if (!indices.has(target)) {
        connect(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(target)));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component);
  };

  for (const node of graphToInspect.keys()) {
    if (!indices.has(node)) connect(node);
  }
  return components;
}

function findCyclicEdges(cycleComponents, graphToInspect) {
  const result = [];
  for (const component of cycleComponents) {
    const members = new Set(component);
    for (const from of component) {
      const absoluteFrom = sourceByKey.get(pathKey(path.join(projectRoot, from)));
      if (!absoluteFrom) continue;
      for (const absoluteTarget of graphToInspect.get(absoluteFrom) ?? []) {
        const target = relative(absoluteTarget);
        if (members.has(target)) result.push(`${from} -> ${target}`);
      }
    }
  }
  return [...new Set(result)].sort();
}

function findRuleViolations(importEntries) {
  const violations = [];
  const add = (ruleId, message, entry) => {
    const target = entry.target ? relative(entry.target) : entry.specifier;
    violations.push({
      key: `${ruleId}|${entry.from}|${target}`,
      ruleId,
      from: entry.from,
      target,
      kind: entry.kind,
      message
    });
  };

  for (const entry of importEntries) {
    const source = classifyFile(entry.from);
    const target = entry.target
      ? classifyFile(relative(entry.target))
      : classifySpecifier(entry.specifier);

    if (
      source.package === 'component-contracts'
      && target
      && target.package !== 'component-contracts'
    ) {
      add(
        'component-contracts-isolation',
        'Component Kernel 不得依赖 App、Runtime、Protocol 或其他产品包',
        entry
      );
    }
    if (
      source.package === 'contracts'
      && target
      && target.package !== 'contracts'
    ) {
      add('contracts-isolation', 'Contracts 不得依赖 App、Runtime 或 Agent Core', entry);
    }
    if (
      source.package === 'agent-core'
      && target
      && target.package !== 'agent-core'
    ) {
      add('agent-core-isolation', 'Agent Core 不得依赖 App、Runtime 或 Contracts', entry);
    }
    if (
      source.package === 'live-work'
      && target
      && target.package !== 'live-work'
    ) {
      add('live-work-isolation', 'Live Work 内核不得依赖 App、Runtime、Contracts 或 Agent Core', entry);
    }
    if (
      source.package === 'live-work'
      && !entry.specifier.startsWith('.')
      && target?.package !== 'live-work'
    ) {
      add('live-work-no-external-imports', 'Live Work 内核只能依赖自身纯 TypeScript 模块', entry);
    }
    if (
      source.package === 'agent-core'
      && !entry.specifier.startsWith('.')
      && target?.package !== 'agent-core'
    ) {
      add('agent-core-no-external-imports', 'Agent Core 只能依赖自身 Domain 与 Ports', entry);
    }
    if (
      source.package === 'runtime'
      && target?.package === 'app'
    ) {
      add('runtime-no-app', 'Runtime 不得依赖 Electron App', entry);
    }
    if (
      source.package === 'component-contracts'
      && isPlatformImport(entry.specifier)
    ) {
      add(
        'component-contracts-no-platform-imports',
        'Component Kernel 不得导入 Node 或 Electron 平台能力',
        entry
      );
    }

    if (
      source.package === 'app'
      && ['runtime', 'agent-core'].includes(target?.package)
    ) {
      add('app-no-runtime-source', 'App 只能通过 Contracts/Host IPC 使用 Runtime', entry);
    }

    if (source.package === 'contracts' && target?.package === 'contracts') {
      const allowed = contractLayerAllowList.get(source.layer);
      if (allowed && !allowed.has(target.layer)) {
        add(
          'contracts-layer-direction',
          `Contracts ${source.layer} 不得依赖 ${target.layer}`,
          entry
        );
      }
    }

    if (source.package === 'agent-core' && target?.package === 'agent-core') {
      const agentCoreAllowList = new Map([
        ['domain', new Set(['domain'])],
        ['ports', new Set(['domain', 'ports'])],
        ['application', new Set(['domain', 'ports', 'application'])],
        ['index', new Set(['domain', 'ports', 'application', 'index'])]
      ]);
      const allowed = agentCoreAllowList.get(source.layer);
      if (allowed && !allowed.has(target.layer)) {
        add(
          'agent-core-layer-direction',
          `Agent Core ${source.layer} 不得依赖 ${target.layer}`,
          entry
        );
      }
    }

    if (source.package === 'runtime' && target?.package === 'runtime') {
      const allowed = runtimeLayerAllowList.get(source.layer);
      if (
        allowed
        && !allowed.has(target.layer)
        && !isAdapterControlPortTypeImport(source, target, entry)
      ) {
        add(
          runtimeTargetLayers.has(target.layer)
            ? 'runtime-layer-direction'
            : 'runtime-target-no-legacy-import',
          `Runtime ${source.layer} 不得依赖 ${target.layer}`,
          entry
        );
      }
    }

    if (source.package === 'app' && target?.package === 'app') {
      const forbiddenProcessTargets = new Map([
        ['renderer', new Set(['main', 'preload'])],
        ['preload', new Set(['main', 'renderer'])],
        ['main', new Set(['preload', 'renderer'])],
        ['shared', new Set(['main', 'preload', 'renderer'])]
      ]);
      if (forbiddenProcessTargets.get(source.layer)?.has(target.layer)) {
        add(
          'app-process-boundary',
          `App ${source.layer} 不得依赖 ${target.layer}`,
          entry
        );
      }
    }

    if (
      source.package === 'app'
      && ['renderer', 'preload'].includes(source.layer)
      && target?.package === 'contracts'
      && !['public', 'desktop', 'common'].includes(target.layer)
    ) {
      add(
        'renderer-public-contract-only',
        `${source.layer} 只能使用 Public/Desktop Contracts`,
        entry
      );
    }

    if (
      source.package === 'app'
      && ['renderer', 'shared'].includes(source.layer)
      && isPlatformImport(entry.specifier)
    ) {
      add(
        'renderer-no-platform-imports',
        `${source.layer} 不得直接导入 Node/Electron 平台能力`,
        entry
      );
    }

    if (
      entry.specifier === '@ariadne/protocol'
      || entry.specifier === '@ariadne/contracts'
    ) {
      add(
        'no-contract-catch-all',
        '必须导入明确的 public/desktop/host/settings 子契约',
        entry
      );
    }
  }

  return dedupeBy(violations, (violation) => violation.key)
    .sort((left, right) => left.key.localeCompare(right.key));
}

function isAdapterControlPortTypeImport(source, target, entry) {
  if (
    source.package !== 'runtime'
    || source.layer !== 'adapters'
    || target?.package !== 'runtime'
    || target.layer !== 'control'
    || !entry.kind.includes('type')
    || !entry.target
  ) {
    return false;
  }
  return relative(entry.target).startsWith('runtime/src/control/ports/');
}

function assertNarrowDependencyExceptions() {
  const source = { package: 'runtime', layer: 'adapters' };
  const target = { package: 'runtime', layer: 'control' };
  const portTarget = path.join(
    projectRoot,
    'runtime',
    'src',
    'control',
    'ports',
    'ArchitectureSelfTest.ts'
  );
  const implementationTarget = path.join(
    projectRoot,
    'runtime',
    'src',
    'control',
    'ArchitectureSelfTest.ts'
  );
  if (
    !isAdapterControlPortTypeImport(source, target, {
      kind: 'static-type',
      target: portTarget
    })
    || isAdapterControlPortTypeImport(source, target, {
      kind: 'static-value',
      target: portTarget
    })
    || isAdapterControlPortTypeImport(source, target, {
      kind: 'static-type',
      target: implementationTarget
    })
  ) {
    throw new Error('architecture_policy_self_test_failed:adapter_control_ports');
  }
}

function classifyFile(file) {
  const normalized = file.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments[0] === 'packages' && segments[1] === 'component-contracts') {
    return { package: 'component-contracts', layer: segments[3] ?? 'index' };
  }
  if (segments[0] === 'packages' && ['protocol', 'contracts'].includes(segments[1])) {
    return {
      package: 'contracts',
      layer: path.basename(segments[3] ?? 'index').replace(/\.(?:ts|tsx)$/u, '')
    };
  }
  if (segments[0] === 'packages' && segments[1] === 'agent-core') {
    const first = segments[3] ?? 'index';
    const second = segments[4];
    return {
      package: 'agent-core',
      layer: first === 'application' && second === 'ports' ? 'ports' : first
    };
  }
  if (segments[0] === 'packages' && segments[1] === 'live-work') {
    return { package: 'live-work', layer: segments[3] ?? 'index' };
  }
  if (segments[0] === 'runtime' && segments[1] === 'src') {
    return { package: 'runtime', layer: segments[2] ?? 'index' };
  }
  if (segments[0] === 'app' && segments[1] === 'src') {
    return { package: 'app', layer: segments[2] ?? 'index' };
  }
  return { package: 'unknown', layer: 'unknown' };
}

function classifySpecifier(specifier) {
  if (specifier === '@ariadne/component-contracts') {
    return { package: 'component-contracts', layer: 'index' };
  }
  if (specifier.startsWith('@ariadne/component-contracts/')) {
    return {
      package: 'component-contracts',
      layer: specifier.slice('@ariadne/component-contracts/'.length).split('/')[0]
    };
  }
  if (specifier === '@ariadne/protocol' || specifier === '@ariadne/contracts') {
    return { package: 'contracts', layer: 'index' };
  }
  for (const packageName of ['@ariadne/protocol', '@ariadne/contracts']) {
    if (specifier.startsWith(`${packageName}/`)) {
      return {
        package: 'contracts',
        layer: specifier.slice(packageName.length + 1).split('/')[0]
      };
    }
  }
  if (specifier === '@ariadne/agent-core') {
    return { package: 'agent-core', layer: 'index' };
  }
  if (specifier.startsWith('@ariadne/agent-core/')) {
    const parts = specifier.slice('@ariadne/agent-core/'.length).split('/');
    return {
      package: 'agent-core',
      layer: parts[0] === 'application' && parts[1] === 'ports'
        ? 'ports'
        : parts[0]
    };
  }
  if (specifier === '@ariadne/live-work') {
    return { package: 'live-work', layer: 'index' };
  }
  if (specifier.startsWith('@ariadne/live-work/')) {
    return {
      package: 'live-work',
      layer: specifier.slice('@ariadne/live-work/'.length).split('/')[0]
    };
  }
  if (specifier === '@ariadne/runtime') {
    return { package: 'runtime', layer: 'index' };
  }
  if (specifier.startsWith('@ariadne/runtime/')) {
    return {
      package: 'runtime',
      layer: specifier.slice('@ariadne/runtime/'.length).split('/')[0]
    };
  }
  if (specifier === '@ariadne/app') {
    return { package: 'app', layer: 'index' };
  }
  if (specifier.startsWith('@ariadne/app/')) {
    return {
      package: 'app',
      layer: specifier.slice('@ariadne/app/'.length).split('/')[0]
    };
  }
  return null;
}

function isPlatformImport(specifier) {
  return specifier === 'electron' || nodeBuiltins.has(specifier);
}

function createBaseline(cycleComponents, cycleEdges, violations) {
  return {
    schemaVersion: 1,
    architectureVersion: 2,
    sourceRoots: roots.map(relative),
    cycles: cycleComponents.map((files) => ({ files })),
    cyclicEdges: cycleEdges,
    ruleViolations: violations.map((violation) => ({
      key: violation.key,
      ruleId: violation.ruleId,
      from: violation.from,
      target: violation.target,
      message: violation.message
    }))
  };
}

function emptyBaseline() {
  return {
    schemaVersion: 1,
    architectureVersion: 2,
    sourceRoots: [],
    cycles: [],
    cyclicEdges: [],
    ruleViolations: []
  };
}

function loadBaseline(file) {
  if (!existsSync(file)) {
    throw new Error(
      `${relative(file)} 不存在；先创建 ADR，再显式运行 --write-baseline --acknowledge-current-debt`
    );
  }
  const content = readFileSync(file, 'utf8');
  let parsed;
  if (path.extname(file).toLowerCase() === '.json') {
    parsed = JSON.parse(content);
  } else {
    const startIndex = content.indexOf(baselineStart);
    const endIndex = content.indexOf(baselineEnd);
    if (startIndex < 0 || endIndex <= startIndex) {
      throw new Error(`${relative(file)} 缺少 architecture-baseline 标记`);
    }
    const block = content
      .slice(startIndex + baselineStart.length, endIndex)
      .trim()
      .replace(/^```json\s*/u, '')
      .replace(/\s*```$/u, '');
    parsed = JSON.parse(block);
  }
  validateBaseline(parsed, file);
  return parsed;
}

function validateBaseline(value, file) {
  const valid = (
    value
    && value.schemaVersion === 1
    && Array.isArray(value.cycles)
    && Array.isArray(value.cyclicEdges)
    && Array.isArray(value.ruleViolations)
  );
  if (!valid) throw new Error(`${relative(file)} 的 baseline schema 无效`);
}

function writeBaseline(file, baseline) {
  const serialized = `${JSON.stringify(baseline, null, 2)}\n`;
  if (path.extname(file).toLowerCase() === '.json') {
    writeFileSync(file, serialized, 'utf8');
    return;
  }
  if (!existsSync(file)) {
    throw new Error(`${relative(file)} 不存在，拒绝创建没有说明文字的基线`);
  }
  const content = readFileSync(file, 'utf8');
  const startIndex = content.indexOf(baselineStart);
  const endIndex = content.indexOf(baselineEnd);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(`${relative(file)} 缺少 architecture-baseline 标记`);
  }
  const replacement = `${baselineStart}\n\`\`\`json\n${serialized}\`\`\`\n${baselineEnd}`;
  const updated = (
    content.slice(0, startIndex)
    + replacement
    + content.slice(endIndex + baselineEnd.length)
  );
  writeFileSync(file, updated, 'utf8');
}

function compareWithBaseline(current, accepted) {
  const acceptedCycleSets = accepted.cycles.map((cycle) => new Set(cycle.files));
  const newCycleComponents = current.cycles
    .map((cycle) => cycle.files)
    .filter((files) => !acceptedCycleSets.some(
      (acceptedFiles) => files.every((file) => acceptedFiles.has(file))
    ));
  const acceptedEdges = new Set(accepted.cyclicEdges);
  const currentEdges = new Set(current.cyclicEdges);
  const acceptedViolations = new Set(
    accepted.ruleViolations.map((violation) => violation.key)
  );
  const currentViolations = new Map(
    current.ruleViolations.map((violation) => [violation.key, violation])
  );
  return {
    newCycleComponents,
    newCyclicEdges: current.cyclicEdges.filter((edge) => !acceptedEdges.has(edge)),
    newRuleViolations: [...currentViolations.values()]
      .filter((violation) => !acceptedViolations.has(violation.key)),
    resolvedCyclicEdges: accepted.cyclicEdges.filter((edge) => !currentEdges.has(edge)),
    resolvedRuleViolations: accepted.ruleViolations
      .filter((violation) => !currentViolations.has(violation.key))
  };
}

function printSummary(report) {
  const current = report.current ?? report.baseline;
  const cycleFileCount = new Set(
    current.cycles.flatMap((cycle) => cycle.files)
  ).size;
  const status = report.ok ? 'PASS' : 'FAIL';
  process.stdout.write(`Architecture gate: ${status}\n`);
  if ('scannedFileCount' in report) {
    process.stdout.write(
      `Scanned: ${report.scannedFileCount} TS/TSX files, `
      + `${report.resolvedInternalEdgeCount} internal edges, `
      + `${report.typeImportCount} type imports\n`
    );
    process.stdout.write(
      `Narrow exceptions: ${report.allowedAdapterControlPortTypeImports.length} `
      + 'adapters -> control/ports type-only imports\n'
    );
  }
  process.stdout.write(
    `Current debt: ${current.cycles.length} SCCs / ${cycleFileCount} files / `
    + `${current.cyclicEdges.length} cyclic edges; `
    + `${current.ruleViolations.length} dependency-rule violations\n`
  );
  process.stdout.write(
    `Delta: +${report.newCycleComponents.length} SCCs, `
    + `+${report.newCyclicEdges.length} cyclic edges, `
    + `+${report.newRuleViolations.length} rule violations; `
    + `-${report.resolvedCyclicEdges.length} cyclic edges, `
    + `-${report.resolvedRuleViolations.length} rule violations\n`
  );
  if (current.cycles.length > 0) {
    const largest = [...current.cycles]
      .sort((left, right) => right.files.length - left.files.length)[0];
    process.stdout.write(
      `Largest SCC: ${largest.files.length} files (${largest.files.slice(0, 3).join(', ')}`
      + `${largest.files.length > 3 ? ', ...' : ''})\n`
    );
  }
}

function printFailures(report) {
  if (parseErrors.length > 0) printParseErrors();
  printList('New cycle components', report.newCycleComponents.map(
    (files) => `${files.length} files: ${files.join(', ')}`
  ));
  printList('New cyclic edges', report.newCyclicEdges);
  printList('New dependency-rule violations', report.newRuleViolations.map(
    (violation) => (
      `[${violation.ruleId}] ${violation.from} -> ${violation.target}: ${violation.message}`
    )
  ));
  printList(
    'Resolved cyclic edges (refresh the baseline in the same change)',
    report.resolvedCyclicEdges
  );
  printList(
    'Resolved dependency-rule violations (refresh the baseline in the same change)',
    report.resolvedRuleViolations.map(
      (violation) => `[${violation.ruleId}] ${violation.from} -> ${violation.target}`
    )
  );
  if (!report.ok) {
    process.stderr.write(
      'The committed baseline must exactly describe current debt. Refresh it only after '
      + 'reviewing a genuine reduction; never use it to hide a regression.\n'
    );
  }
}

function printParseErrors() {
  printList('TypeScript parse errors', parseErrors.map((error) => (
    `${error.file}${error.line ? `:${error.line}` : ''}: ${error.message}`
  )));
}

function printList(title, items) {
  if (items.length === 0) return;
  process.stderr.write(`${title} (${items.length}):\n`);
  for (const item of items.slice(0, 50)) {
    process.stderr.write(`  - ${item}\n`);
  }
  if (items.length > 50) {
    process.stderr.write(`  - ... ${items.length - 50} more\n`);
  }
}

function compareStringArrays(left, right) {
  return left.join('\0').localeCompare(right.join('\0'));
}

function dedupeBy(values, keySelector) {
  const seen = new Set();
  return values.filter((value) => {
    const key = keySelector(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pathKey(file) {
  return path.resolve(file).replaceAll('\\', '/').toLowerCase();
}

function relative(file) {
  return path.relative(projectRoot, file).replaceAll('\\', '/');
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
