import type { AgentToolJsonValue } from '@ariadne/agent-core';

import type {
  TrustedAgentToolRegistrationV1
} from '../../adapters/tool/TrustedAgentToolCatalogCompiler.js';
import type { HostCapabilityClient } from '../../ingress/HostCapabilityClient.js';
import {
  MAX_TEXT_BYTES,
  failed,
  objectSchema,
  registration,
  requiredStringObject,
  requiredStringProperty,
  succeeded
} from './FirstPartyAgentToolSupport.js';

export function createComputerReadAgentToolRegistrations(
  host: HostCapabilityClient
): readonly TrustedAgentToolRegistrationV1[] {
  return [
    listDirectoryRegistration(host),
    openPathRegistration(host),
    readTextFileRegistration(host)
  ];
}

function listDirectoryRegistration(host: HostCapabilityClient): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'computer.list_directory',
    model: {
      description: 'List a bounded directory outside the Workspace through the read-only host capability.',
      guidance: ['Use only for paths explicitly in scope; this Tool cannot modify the computer.']
    },
    presentation: { kind: 'file_read', label: '查看电脑目录', resultVisibility: 'protected' },
    capabilityIds: ['computer.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: absolutePathSchema('Absolute directory path.'),
    outputSchema: { type: 'object' },
    validate: (input) => requiredStringObject(input, 'path'),
    execute: (input) => executeHostRead(host, {
      kind: 'computer.list_directory',
      path: requiredStringProperty(input, 'path')
    }, 'computer_list_directory_failed')
  });
}

function readTextFileRegistration(host: HostCapabilityClient): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'computer.read_text_file',
    model: {
      description: 'Read one UTF-8 text file outside the Workspace through the read-only host capability.',
      guidance: ['Use only for an exact absolute path already placed in scope.']
    },
    presentation: { kind: 'file_read', label: '读取电脑文件', resultVisibility: 'protected' },
    capabilityIds: ['computer.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'read',
    approval: 'never',
    inputSchema: absolutePathSchema('Absolute UTF-8 text file path.'),
    outputSchema: { type: 'object' },
    validate: (input) => requiredStringObject(input, 'path'),
    execute: (input) => executeHostRead(host, {
      kind: 'computer.read_text_file',
      path: requiredStringProperty(input, 'path')
    }, 'computer_read_text_file_failed')
  });
}

function openPathRegistration(host: HostCapabilityClient): TrustedAgentToolRegistrationV1 {
  return registration({
    implementationModuleUrl: import.meta.url,
    toolName: 'computer.open_path',
    model: {
      description: 'Open one non-executable file or directory in the host operating system.',
      guidance: ['This is an external UI action and does not grant write or command authority.']
    },
    presentation: { kind: 'external', label: '打开电脑路径', resultVisibility: 'protected' },
    capabilityIds: ['computer.read'],
    requiredWorkspaceAccess: 'read',
    sideEffect: 'external',
    approval: 'never',
    inputSchema: absolutePathSchema('Absolute directory or non-executable file path.'),
    outputSchema: { type: 'object' },
    validate: (input) => requiredStringObject(input, 'path'),
    execute: (input) => executeHostRead(host, {
      kind: 'computer.open_path',
      path: requiredStringProperty(input, 'path')
    }, 'computer_open_path_failed')
  });
}

function absolutePathSchema(description: string): AgentToolJsonValue {
  return objectSchema({ path: { type: 'string', description } }, ['path']);
}

async function executeHostRead(
  host: HostCapabilityClient,
  operation: Parameters<HostCapabilityClient['request']>[0],
  errorCode: string
) {
  try {
    const result = await host.request(operation, 30_000);
    const json = JSON.stringify(result);
    if (Buffer.byteLength(json, 'utf8') > MAX_TEXT_BYTES * 2) {
      throw new Error('computer_read_result_exceeds_limit');
    }
    return succeeded(JSON.parse(json) as AgentToolJsonValue);
  } catch (error) {
    return failed(errorCode, error);
  }
}
