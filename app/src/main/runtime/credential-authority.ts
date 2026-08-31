import type { CredentialCapabilityOperation } from '@ariadne/protocol/host';
import {
  AGENT_PROVIDER_IDS,
  type AgentProviderId,
  type AgentSettingsMutation,
  type AgentSettingsMutationResult
} from '@shared/contract';

import type { AgentSettingsRepository } from '../persistence/agent-settings-repository';
import type { McpOAuthCredentialVault } from '../persistence/mcp-oauth-credential-vault';

/** Main-only credential owner. Secret values never enter settings views or bootstrap. */
export class MainCredentialAuthority {
  public constructor(
    private readonly settings: AgentSettingsRepository,
    private readonly mcpVault: McpOAuthCredentialVault
  ) {}

  public handle(operation: CredentialCapabilityOperation): Record<string, unknown> {
    return operation.kind === 'credential.resolve'
      ? this.resolve(operation)
      : this.describe(operation.credentialRef);
  }

  public acceptsUpdate(mutation: AgentSettingsMutation): boolean {
    return mutation.operations.length > 0 && mutation.operations.every((operation) => (
      operation.kind === 'provider.update'
      && Object.keys(operation.patch).length > 0
      && Object.keys(operation.patch).every(
        (key) => key === 'apiKey' || key === 'clearApiKey'
      )
    ));
  }

  public update(mutation: AgentSettingsMutation): Promise<AgentSettingsMutationResult> {
    if (!this.acceptsUpdate(mutation)) throw new Error('credential_update_scope_invalid');
    return this.settings.mutate(mutation);
  }

  public clientInformation = (...args: Parameters<McpOAuthCredentialVault['clientInformation']>) => (
    this.mcpVault.clientInformation(...args)
  );
  public saveClientInformation = (...args: Parameters<McpOAuthCredentialVault['saveClientInformation']>) => (
    this.mcpVault.saveClientInformation(...args)
  );
  public tokens = (...args: Parameters<McpOAuthCredentialVault['tokens']>) => (
    this.mcpVault.tokens(...args)
  );
  public saveTokens = (...args: Parameters<McpOAuthCredentialVault['saveTokens']>) => (
    this.mcpVault.saveTokens(...args)
  );
  public saveCodeVerifier = (...args: Parameters<McpOAuthCredentialVault['saveCodeVerifier']>) => (
    this.mcpVault.saveCodeVerifier(...args)
  );
  public codeVerifier = (...args: Parameters<McpOAuthCredentialVault['codeVerifier']>) => (
    this.mcpVault.codeVerifier(...args)
  );
  public saveExpectedState = (...args: Parameters<McpOAuthCredentialVault['saveExpectedState']>) => (
    this.mcpVault.saveExpectedState(...args)
  );
  public consumeExpectedState = (...args: Parameters<McpOAuthCredentialVault['consumeExpectedState']>) => (
    this.mcpVault.consumeExpectedState(...args)
  );
  public saveDiscoveryState = (...args: Parameters<McpOAuthCredentialVault['saveDiscoveryState']>) => (
    this.mcpVault.saveDiscoveryState(...args)
  );
  public discoveryState = (...args: Parameters<McpOAuthCredentialVault['discoveryState']>) => (
    this.mcpVault.discoveryState(...args)
  );
  public invalidate = (...args: Parameters<McpOAuthCredentialVault['invalidate']>) => (
    this.mcpVault.invalidate(...args)
  );

  private resolve(
    operation: Extract<CredentialCapabilityOperation, { readonly kind: 'credential.resolve' }>
  ): Record<string, unknown> {
    const providerId = modelProviderId(operation.credentialRef);
    if (operation.purpose !== 'model_inference' || providerId === undefined) {
      throw new Error('credential_resolution_not_authorized');
    }
    const credential = this.settings.resolveProviderApiKey(providerId);
    if (credential === undefined) throw new Error('credential_not_configured');
    return { credential };
  }

  private describe(credentialRef: string): Record<string, unknown> {
    const providerId = modelProviderId(credentialRef);
    if (providerId !== undefined) return {
      configured: this.settings.describeProviderApiKey(providerId) === 'configured',
      source: 'os_secure_storage',
      writable: true
    };
    if (credentialRef.startsWith('mcp:')) return {
      configured: this.mcpVault.hasCredentialRecord(credentialRef),
      source: 'oauth_vault',
      writable: false
    };
    if (credentialRef.startsWith('subagent:')) return {
      configured: this.settings.getRuntimeSettings().subagentProviders.some(
        (provider) => `subagent:${provider.providerId}` === credentialRef
      ),
      source: 'external_provider',
      writable: false
    };
    throw new Error('credential_reference_unknown');
  }
}

function modelProviderId(credentialRef: string): AgentProviderId | undefined {
  if (!credentialRef.startsWith('model:')) return undefined;
  const candidate = credentialRef.slice('model:'.length);
  return (AGENT_PROVIDER_IDS as readonly string[]).includes(candidate)
    ? candidate as AgentProviderId
    : undefined;
}
