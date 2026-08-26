import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type {
  TrustedAgentToolRegistrationV1
} from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { HostCapabilityClient } from '../../ingress/HostCapabilityClient.js';
import {
  MAX_BROWSER_ARTIFACT_BYTES,
  MAX_TEXT_BYTES,
  failed,
  hasUnknownKeys,
  isRecord,
  normalizeRelativePath,
  objectSchema,
  registration,
  requiredBoundedStringObject,
  requiredStringObject,
  requiredStringPairObject,
  requiredStringProperty,
  requireWorkspace,
  resolveWritableWorkspacePath,
  succeeded,
  type WorkspaceBinding
} from './FirstPartyAgentToolSupport.js';

export function createBrowserAgentToolRegistrations(
  host: HostCapabilityClient,
  roots: ReadonlyMap<string, WorkspaceBinding>
): readonly TrustedAgentToolRegistrationV1[] {
  return [
    browserAccessibilitySnapshotRegistration(host),
    browserClickRegistration(host),
    browserDownloadRegistration(host, roots),
    browserNavigateRegistration(host),
    browserScreenshotRegistration(host, roots),
    browserScrollRegistration(host),
    browserTypeRegistration(host),
    browserWaitRegistration(host)
  ];
}

function browserScreenshotRegistration(
  host: HostCapabilityClient,
  roots: ReadonlyMap<string, WorkspaceBinding>
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'browser.screenshot',
    capabilityIds: ['browser.use', 'workspace.write'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'write',
    approval: 'required',
    inputSchema: objectSchema({
      path: { type: 'string', description: 'Workspace-relative PNG output path.' }
    }, ['path']),
    outputSchema: { type: 'object' },
    validate: (input) => requiredStringObject(input, 'path'),
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'write');
        const relativePath = requiredStringProperty(input, 'path');
        const response = await host.request({ kind: 'browser.screenshot' }, 35_000);
        return succeeded(await persistBrowserArtifact({
          response,
          workspace,
          relativePath,
          expectedMediaType: 'image/png'
        }));
      } catch (error) {
        return failed('browser_screenshot_failed', error);
      }
    }
  });
}

function browserDownloadRegistration(
  host: HostCapabilityClient,
  roots: ReadonlyMap<string, WorkspaceBinding>
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'browser.download',
    capabilityIds: ['browser.use', 'workspace.write'],
    requiredWorkspaceAccess: 'write',
    sideEffect: 'write',
    approval: 'required',
    timeoutMs: 120_000,
    inputSchema: objectSchema({
      url: { type: 'string', description: 'HTTPS download URL without embedded credentials.' },
      path: { type: 'string', description: 'Workspace-relative output path.' }
    }, ['path', 'url']),
    outputSchema: { type: 'object' },
    validate: validateBrowserDownloadInput,
    execute: async (input, context) => {
      try {
        const workspace = requireWorkspace(roots, context, 'write');
        const url = requiredStringProperty(input, 'url');
        const relativePath = requiredStringProperty(input, 'path');
        assertBrowserHttpsUrl(url);
        const response = await host.request({ kind: 'browser.download', url }, 120_000);
        return succeeded(await persistBrowserArtifact({ response, workspace, relativePath }));
      } catch (error) {
        return failed('browser_download_failed', error);
      }
    }
  });
}

function browserClickRegistration(
  host: HostCapabilityClient
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'browser.click',
    capabilityIds: ['browser.use'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'external',
    approval: 'required',
    inputSchema: objectSchema({
      selector: { type: 'string', description: 'Visible element CSS selector.' }
    }, ['selector']),
    outputSchema: { type: 'object' },
    validate: (input) => requiredBoundedStringObject(input, 'selector', 2_048),
    execute: async (input) => {
      try {
        const selector = requiredStringProperty(input, 'selector');
        return succeeded(await boundedHostResult(host.request({
          kind: 'browser.click',
          selector
        }, 30_000)));
      } catch (error) {
        return failed('browser_click_failed', error);
      }
    }
  });
}

function browserTypeRegistration(
  host: HostCapabilityClient
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'browser.type',
    capabilityIds: ['browser.use'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'external',
    approval: 'required',
    inputSchema: objectSchema({
      selector: { type: 'string', description: 'Visible input CSS selector.' },
      text: { type: 'string', description: 'Text to enter.' },
      sensitive: { type: 'boolean', description: 'True for secrets or other sensitive values.' }
    }, ['selector', 'text']),
    outputSchema: { type: 'object' },
    validate: validateBrowserTypeInput,
    execute: async (input) => {
      try {
        if (!isRecord(input)) throw new Error('tool_input_invalid');
        const selector = requiredStringProperty(input, 'selector');
        const text = requiredStringProperty(input, 'text', true);
        const sensitive = input.sensitive === true;
        return succeeded(await boundedHostResult(host.request({
          kind: 'browser.type',
          selector,
          text,
          sensitive
        }, 30_000)));
      } catch (error) {
        return failed('browser_type_failed', error);
      }
    }
  });
}

function browserScrollRegistration(
  host: HostCapabilityClient
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'browser.scroll',
    capabilityIds: ['browser.use'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: objectSchema({
      deltaX: { type: 'number', minimum: -100_000, maximum: 100_000 },
      deltaY: { type: 'number', minimum: -100_000, maximum: 100_000 }
    }, ['deltaY']),
    outputSchema: { type: 'object' },
    validate: validateBrowserScrollInput,
    execute: async (input) => {
      try {
        if (!isRecord(input) || typeof input.deltaY !== 'number') {
          throw new Error('tool_input_invalid');
        }
        return succeeded(await boundedHostResult(host.request({
          kind: 'browser.scroll',
          deltaX: typeof input.deltaX === 'number' ? input.deltaX : 0,
          deltaY: input.deltaY
        }, 30_000)));
      } catch (error) {
        return failed('browser_scroll_failed', error);
      }
    }
  });
}

function browserNavigateRegistration(
  host: HostCapabilityClient
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'browser.navigate',
    capabilityIds: ['browser.use'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: objectSchema({
      url: { type: 'string', description: 'HTTPS URL without embedded credentials.' }
    }, ['url']),
    outputSchema: { type: 'object' },
    validate: validateBrowserNavigateInput,
    execute: async (input) => {
      try {
        const url = requiredStringProperty(input, 'url');
        assertBrowserHttpsUrl(url);
        return succeeded(await boundedHostResult(host.request({
          kind: 'browser.navigate',
          url
        }, 30_000)));
      } catch (error) {
        return failed('browser_navigate_failed', error);
      }
    }
  });
}

function browserAccessibilitySnapshotRegistration(
  host: HostCapabilityClient
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'browser.accessibility_snapshot',
    capabilityIds: ['browser.use'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: objectSchema({}, []),
    outputSchema: { type: 'object' },
    validate: (input) => (
      isRecord(input) && Object.keys(input).length === 0
        ? { status: 'accepted' as const, input: {} }
        : { status: 'rejected' as const }
    ),
    execute: async () => {
      try {
        return succeeded(await boundedHostResult(host.request({
          kind: 'browser.accessibility_snapshot'
        }, 30_000)));
      } catch (error) {
        return failed('browser_snapshot_failed', error);
      }
    }
  });
}

function browserWaitRegistration(
  host: HostCapabilityClient
): TrustedAgentToolRegistrationV1 {
  return registration({
    toolName: 'browser.wait',
    capabilityIds: ['browser.use'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: objectSchema({
      milliseconds: { type: 'integer', minimum: 0, maximum: 30_000 }
    }, ['milliseconds']),
    outputSchema: { type: 'object' },
    validate: validateBrowserWaitInput,
    execute: async (input) => {
      try {
        if (!isRecord(input) || typeof input.milliseconds !== 'number') {
          throw new Error('tool_input_invalid');
        }
        return succeeded(await boundedHostResult(host.request({
          kind: 'browser.wait',
          milliseconds: input.milliseconds
        }, 35_000)));
      } catch (error) {
        return failed('browser_wait_failed', error);
      }
    }
  });
}

function validateBrowserNavigateInput(input: AgentToolJsonValue) {
  const validated = requiredStringObject(input, 'url');
  if (validated.status === 'rejected') return validated;
  try {
    assertBrowserHttpsUrl(validated.input.url as string);
    return validated;
  } catch {
    return { status: 'rejected' as const };
  }
}

function validateBrowserDownloadInput(input: AgentToolJsonValue) {
  const validated = requiredStringPairObject(input, 'url', 'path');
  if (validated.status === 'rejected') return validated;
  try {
    assertBrowserHttpsUrl(validated.input.url as string);
    return validated;
  } catch {
    return { status: 'rejected' as const };
  }
}

function validateBrowserWaitInput(input: AgentToolJsonValue) {
  if (
    !isRecord(input)
    || hasUnknownKeys(input, ['milliseconds'])
    || typeof input.milliseconds !== 'number'
    || !Number.isSafeInteger(input.milliseconds)
    || input.milliseconds < 0
    || input.milliseconds > 30_000
  ) return { status: 'rejected' as const };
  return { status: 'accepted' as const, input: { milliseconds: input.milliseconds } };
}

function validateBrowserTypeInput(input: AgentToolJsonValue) {
  if (
    !isRecord(input)
    || hasUnknownKeys(input, ['selector', 'text', 'sensitive'])
    || typeof input.selector !== 'string'
    || input.selector.length === 0
    || input.selector.length > 2_048
    || typeof input.text !== 'string'
    || input.text.length > 100_000
    || (input.sensitive !== undefined && typeof input.sensitive !== 'boolean')
  ) return { status: 'rejected' as const };
  return {
    status: 'accepted' as const,
    input: {
      selector: input.selector,
      text: input.text,
      sensitive: input.sensitive === true
    }
  };
}

function validateBrowserScrollInput(input: AgentToolJsonValue) {
  if (!isRecord(input) || hasUnknownKeys(input, ['deltaX', 'deltaY'])) {
    return { status: 'rejected' as const };
  }
  const deltaX = input.deltaX ?? 0;
  const deltaY = input.deltaY;
  if (
    typeof deltaX !== 'number'
    || !Number.isFinite(deltaX)
    || deltaX < -100_000
    || deltaX > 100_000
    || typeof deltaY !== 'number'
    || !Number.isFinite(deltaY)
    || deltaY < -100_000
    || deltaY > 100_000
  ) return { status: 'rejected' as const };
  return { status: 'accepted' as const, input: { deltaX, deltaY } };
}

function assertBrowserHttpsUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || value.length > 2_048
  ) throw new Error('browser_url_invalid');
}

async function boundedHostResult(
  promise: Promise<Record<string, unknown>>
): Promise<AgentToolJsonValue> {
  const value = await promise;
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error('browser_result_exceeds_limit');
  }
  return JSON.parse(json) as AgentToolJsonValue;
}

async function persistBrowserArtifact(input: {
  readonly response: Readonly<Record<string, unknown>>;
  readonly workspace: WorkspaceBinding;
  readonly relativePath: string;
  readonly expectedMediaType?: string;
}): Promise<AgentToolJsonValue> {
  const { dataBase64, mediaType, name } = input.response;
  if (
    typeof dataBase64 !== 'string'
    || dataBase64.length === 0
    || dataBase64.length > Math.ceil(MAX_BROWSER_ARTIFACT_BYTES / 3) * 4 + 4
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(dataBase64)
    || typeof mediaType !== 'string'
    || mediaType.length === 0
    || mediaType.length > 256
    || (input.expectedMediaType !== undefined && mediaType !== input.expectedMediaType)
    || (name !== undefined && (typeof name !== 'string' || name.length > 512))
  ) throw new Error('browser_artifact_invalid');
  const bytes = Buffer.from(dataBase64, 'base64');
  if (
    bytes.byteLength === 0
    || bytes.byteLength > MAX_BROWSER_ARTIFACT_BYTES
    || bytes.toString('base64').replace(/=+$/u, '') !== dataBase64.replace(/=+$/u, '')
  ) throw new Error('browser_artifact_invalid');
  const target = await resolveWritableWorkspacePath(
    input.workspace.rootPath,
    input.relativePath
  );
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return {
    path: normalizeRelativePath(input.relativePath),
    mediaType,
    byteLength: bytes.byteLength,
    ...(typeof name === 'string' ? { sourceName: name } : {})
  };
}
