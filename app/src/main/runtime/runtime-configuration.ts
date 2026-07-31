import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import type { RuntimeSupervisorOptions } from './runtime-supervisor';
import type { RuntimeAgentSettings } from '../persistence/agent-settings-repository';
import { AGENT_PROVIDER_CATALOG, AGENT_PROVIDER_IDS } from '@shared/contract';

interface DesktopRuntimeConfigurationInput {
  appPath: string;
  userDataPath: string;
  resourcesPath: string;
  appVersion: string;
  packaged: boolean;
  executablePath: string;
  agentSettings: RuntimeAgentSettings;
  environment?: NodeJS.ProcessEnv;
}

interface DefaultWorkspaceRootInput {
  appPath: string;
  userDataPath: string;
  packaged: boolean;
  environment?: NodeJS.ProcessEnv;
}

export function resolveDefaultWorkspaceRoot(input: DefaultWorkspaceRootInput): string {
  const configured = input.packaged
    ? undefined
    : (input.environment ?? process.env).ARIADNE_WORKSPACE_ROOT?.trim();
  if (configured) return requireAbsoluteEnvironmentPath('ARIADNE_WORKSPACE_ROOT', configured);
  return input.packaged
    ? resolve(input.userDataPath, 'workspace')
    : resolve(input.appPath, '..');
}

export function createDesktopRuntimeConfiguration(
  input: DesktopRuntimeConfigurationInput
): RuntimeSupervisorOptions {
  const environment = { ...(input.environment ?? process.env) };
  for (const id of AGENT_PROVIDER_IDS) {
    const variable = AGENT_PROVIDER_CATALOG[id].apiKeyEnvironmentVariable;
    delete environment[variable];
    const apiKey = input.agentSettings.providers[id].apiKey;
    if (apiKey) environment[variable] = apiKey;
  }
  const allowDevelopmentOverrides = !input.packaged;
  const overrideEntry = allowDevelopmentOverrides
    ? environment.ARIADNE_RUNTIME_ENTRY?.trim()
    : undefined;
  const packagedRuntimeRoot = join(
    input.resourcesPath,
    'runtime',
    'node_modules',
    '@ariadne',
    'runtime'
  );
  const runtimeEntry = overrideEntry
    ? requireAbsoluteEnvironmentPath('ARIADNE_RUNTIME_ENTRY', overrideEntry)
    : input.packaged
      ? join(packagedRuntimeRoot, 'dist', 'entry', 'runtime-process.js')
      : resolve(input.appPath, '..', 'runtime', 'dist', 'entry', 'runtime-process.js');
  const installRoot = resolve(dirname(runtimeEntry), '..', '..');
  const runtimeBuildManifestPath = join(installRoot, 'dist', 'runtime-build.json');
  const configuredExecutable = allowDevelopmentOverrides
    ? environment.ARIADNE_RUNTIME_NODE_EXECUTABLE?.trim()
    : undefined;
  const executablePath = configuredExecutable
    ? requireAbsoluteEnvironmentPath('ARIADNE_RUNTIME_NODE_EXECUTABLE', configuredExecutable)
    : input.packaged
      ? join(input.resourcesPath, 'runtime-runner', process.platform === 'win32' ? 'node.exe' : 'node')
      : resolveDevelopmentNodeExecutable(environment, input.executablePath);
  delete environment.ELECTRON_RUN_AS_NODE;
  const environmentModelRoots = allowDevelopmentOverrides
    ? parseModelRoots(environment.ARIADNE_MODEL_ROOTS)
    : [];
  const profile = allowDevelopmentOverrides
    ? environment.ARIADNE_RUNTIME_PROFILE?.trim() || 'default'
    : 'default';
  delete environment.ARIADNE_RUNTIME_ENTRY;
  delete environment.ARIADNE_RUNTIME_NODE_EXECUTABLE;
  delete environment.ARIADNE_MODEL_ROOTS;
  delete environment.ARIADNE_RUNTIME_PROFILE;
  delete environment.ARIADNE_WORKSPACE_ROOT;

  return {
    runtimeEntry,
    runtimeBuildManifestPath,
    installRoot,
    dataRoot: join(input.userDataPath, 'runtime'),
    modelRoots: [...new Set([
      ...input.agentSettings.localModelRoots.map((entry) => requireAbsoluteEnvironmentPath('localModelRoots', entry)),
      ...environmentModelRoots
    ])],
    modelProviders: AGENT_PROVIDER_IDS.map((providerId) => {
      const definition = AGENT_PROVIDER_CATALOG[providerId];
      const { enabled, baseUrl, model, inference } = input.agentSettings.providers[providerId];
      return {
        providerId,
        name: definition.runtimeModelId,
        protocol: definition.protocol,
        credentialEnvironmentVariable: definition.apiKeyEnvironmentVariable,
        enabled,
        baseUrl,
        model,
        inference
      };
    }),
    routingStrategy: input.agentSettings.routingStrategy,
    agentPermissions: structuredClone(input.agentSettings.permissions),
    runtimePolicy: structuredClone(input.agentSettings.runtimePolicy),
    workspaces: input.agentSettings.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      label: basename(workspace.rootPath) || 'Ariadne Workspace',
      rootPath: requireAbsoluteEnvironmentPath('workspaceRoot', workspace.rootPath),
      access: workspace.access
    })),
    profile,
    appVersion: input.appVersion,
    runtimeVersion: '0.1.0',
    production: input.packaged,
    executablePath,
    environment
  };
}

function parseModelRoots(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => requireAbsoluteEnvironmentPath('ARIADNE_MODEL_ROOTS', entry));
}

function requireAbsoluteEnvironmentPath(name: string, value: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must contain absolute paths.`);
  return resolve(value);
}

function resolveDevelopmentNodeExecutable(
  environment: NodeJS.ProcessEnv,
  fallbackExecutable: string
): string {
  const candidates = [environment.npm_node_execpath, environment.NODE]
    .filter((candidate): candidate is string => Boolean(candidate?.trim()))
    .map((candidate) => candidate.trim());
  const pathValue = environment.Path ?? environment.PATH;
  if (pathValue) {
    for (const directory of pathValue.split(delimiter).map((entry) => entry.trim()).filter(Boolean)) {
      candidates.push(join(directory, process.platform === 'win32' ? 'node.exe' : 'node'));
    }
  }
  if (!process.versions.electron) candidates.push(fallbackExecutable);
  const executable = candidates.find((candidate) => isAbsolute(candidate) && existsSync(candidate));
  if (!executable) {
    throw new Error('A standalone Node executable is required for the Runtime process.');
  }
  return resolve(executable);
}
