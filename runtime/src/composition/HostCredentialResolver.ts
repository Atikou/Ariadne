import type { CredentialResolver, CredentialDescription, CredentialPurpose } from '../control/ports/CredentialResolver.js';
import type { HostCapabilityClient } from '../ingress/HostCapabilityClient.js';

export class HostCredentialResolver implements CredentialResolver {
  public constructor(private readonly host: HostCapabilityClient) {}

  public async resolve(
    credentialRef: string,
    purpose: CredentialPurpose,
    signal: AbortSignal
  ): Promise<string> {
    signal.throwIfAborted();
    const result = await this.host.request({
      kind: 'credential.resolve',
      credentialRef,
      purpose
    });
    signal.throwIfAborted();
    if (
      Object.keys(result).length !== 1
      || typeof result.credential !== 'string'
      || result.credential.length < 1
      || result.credential.length > 32_768
    ) throw new Error('credential_resolution_invalid');
    return result.credential;
  }

  public async describe(
    credentialRef: string,
    signal: AbortSignal
  ): Promise<CredentialDescription> {
    signal.throwIfAborted();
    const result = await this.host.request({ kind: 'credential.describe', credentialRef });
    signal.throwIfAborted();
    if (
      Object.keys(result).length !== 3
      || typeof result.configured !== 'boolean'
      || typeof result.writable !== 'boolean'
      || !['os_secure_storage', 'oauth_vault', 'external_provider'].includes(
        String(result.source)
      )
    ) throw new Error('credential_description_invalid');
    return {
      configured: result.configured,
      source: result.source as CredentialDescription['source'],
      writable: result.writable
    };
  }
}
