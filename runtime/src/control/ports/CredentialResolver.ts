export type CredentialPurpose = 'model_inference' | 'mcp_oauth' | 'subagent';

export interface CredentialDescription {
  readonly configured: boolean;
  readonly source: 'os_secure_storage' | 'oauth_vault' | 'external_provider';
  readonly writable: boolean;
}

/** Resolves one opaque reference once at the owner operation boundary. */
export interface CredentialResolver {
  resolve(
    credentialRef: string,
    purpose: CredentialPurpose,
    signal: AbortSignal
  ): Promise<string>;
  describe(credentialRef: string, signal: AbortSignal): Promise<CredentialDescription>;
}
