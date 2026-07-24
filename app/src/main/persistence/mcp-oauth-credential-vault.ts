import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { z } from 'zod';

import type { SecretCipher } from './secret-cipher';

const credentialRefSchema = z.string().regex(/^[a-z][a-z0-9._:-]{2,255}$/u);
const encryptedRecordSchema = z.object({
  ciphertext: z.string().min(1).max(1024 * 1024),
  updatedAt: z.string().datetime()
}).strict();
const vaultFileSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.record(credentialRefSchema, encryptedRecordSchema)
}).strict();
const secretRecordSchema = z.object({
  clientInformation: OAuthClientInformationSchema.optional(),
  tokens: OAuthTokensSchema.optional(),
  codeVerifier: z.string().min(43).max(128).optional(),
  expectedState: z.string().min(16).max(512).optional(),
  discoveryState: z.record(z.string(), z.unknown()).optional()
}).strict();

type VaultFile = z.infer<typeof vaultFileSchema>;
type SecretRecord = z.infer<typeof secretRecordSchema>;

/**
 * Main-only encrypted credential store. The settings file carries opaque
 * references; tokens, client secrets and PKCE verifier/state never enter the
 * Runtime bootstrap or Renderer contract.
 */
export class McpOAuthCredentialVault {
  private file: VaultFile = { schemaVersion: 1, records: {} };
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly cipher: SecretCipher
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      this.file = vaultFileSchema.parse(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (!isMissingFile(error)) throw new Error('mcp_oauth_vault_invalid', { cause: error });
      await this.persist(this.file);
    }
    this.initialized = true;
  }

  async clientInformation(credentialRef: string): Promise<OAuthClientInformationMixed | undefined> {
    return this.read(credentialRef).clientInformation;
  }

  async saveClientInformation(
    credentialRef: string,
    clientInformation: OAuthClientInformationMixed
  ): Promise<void> {
    const parsed = OAuthClientInformationSchema.parse(clientInformation);
    await this.update(credentialRef, (record) => ({ ...record, clientInformation: parsed }));
  }

  async tokens(credentialRef: string): Promise<OAuthTokens | undefined> {
    return this.read(credentialRef).tokens;
  }

  async saveTokens(credentialRef: string, tokens: OAuthTokens): Promise<void> {
    const parsed = OAuthTokensSchema.parse(tokens);
    await this.update(credentialRef, (record) => ({ ...record, tokens: parsed }));
  }

  async saveCodeVerifier(credentialRef: string, codeVerifier: string): Promise<void> {
    await this.update(credentialRef, (record) =>
      secretRecordSchema.parse({ ...record, codeVerifier }));
  }

  async codeVerifier(credentialRef: string): Promise<string> {
    const verifier = this.read(credentialRef).codeVerifier;
    if (!verifier) throw new Error('mcp_oauth_code_verifier_missing');
    return verifier;
  }

  async saveExpectedState(credentialRef: string, expectedState: string): Promise<void> {
    await this.update(credentialRef, (record) =>
      secretRecordSchema.parse({ ...record, expectedState }));
  }

  async consumeExpectedState(credentialRef: string, actualState: string): Promise<void> {
    const current = this.read(credentialRef);
    if (!current.expectedState || !timingSafeEqualText(current.expectedState, actualState)) {
      throw new Error('mcp_oauth_state_mismatch');
    }
    await this.update(credentialRef, ({ expectedState: _state, ...record }) => record);
  }

  async discoveryState(credentialRef: string): Promise<OAuthDiscoveryState | undefined> {
    return this.read(credentialRef).discoveryState as OAuthDiscoveryState | undefined;
  }

  async saveDiscoveryState(
    credentialRef: string,
    discoveryState: OAuthDiscoveryState
  ): Promise<void> {
    await this.update(credentialRef, (record) =>
      secretRecordSchema.parse({
        ...record,
        discoveryState: structuredClone(discoveryState) as unknown as Record<string, unknown>
      }));
  }

  async invalidate(
    credentialRef: string,
    scope: Parameters<NonNullable<OAuthClientProvider['invalidateCredentials']>>[0]
  ): Promise<void> {
    await this.update(credentialRef, (record) => {
      if (scope === 'all') return {};
      const next = { ...record };
      if (scope === 'client') delete next.clientInformation;
      if (scope === 'tokens') delete next.tokens;
      if (scope === 'verifier') {
        delete next.codeVerifier;
        delete next.expectedState;
      }
      if (scope === 'discovery') delete next.discoveryState;
      return next;
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private read(credentialRef: string): SecretRecord {
    this.assertInitialized();
    const ref = credentialRefSchema.parse(credentialRef);
    const encrypted = this.file.records[ref];
    if (!encrypted) return {};
    return secretRecordSchema.parse(JSON.parse(this.cipher.decrypt(encrypted.ciphertext)));
  }

  private async update(
    credentialRef: string,
    mutate: (record: SecretRecord) => SecretRecord
  ): Promise<void> {
    this.assertInitialized();
    const ref = credentialRefSchema.parse(credentialRef);
    const next = secretRecordSchema.parse(mutate(this.read(ref)));
    const encrypted = {
      ciphertext: this.cipher.encrypt(JSON.stringify(next)),
      updatedAt: new Date().toISOString()
    };
    this.file = {
      schemaVersion: 1,
      records: { ...this.file.records, [ref]: encrypted }
    };
    this.writeQueue = this.writeQueue.then(() => this.persist(this.file));
    await this.writeQueue;
  }

  private async persist(file: VaultFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await rename(temporary, this.filePath);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('mcp_oauth_vault_not_initialized');
  }
}

function timingSafeEqualText(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  if (expectedBytes.byteLength !== actualBytes.byteLength) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
