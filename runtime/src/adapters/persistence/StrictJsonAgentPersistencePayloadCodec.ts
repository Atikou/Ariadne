import {
  AgentPersistencePayloadRejectedError,
  MAX_PROTECTED_AGENT_TURN_INPUT_SNAPSHOT_UTF8_BYTES,
  type AgentJsonValue,
  type AgentPersistencePayloadCodec,
  type AgentPersistencePayloadContext,
  type EncodedAgentPersistencePayload
} from '@ariadne/agent-core';

const CODEC_ID = 'strict-json-v1';
const SENSITIVE_FIELD_NAMES = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authentication',
  'authtoken',
  'clientsecret',
  'cookie',
  'credential',
  'credentials',
  'idtoken',
  'password',
  'passwd',
  'privatekey',
  'proxyauthorization',
  'refreshtoken',
  'secret',
  'setcookie',
  'token',
  'xapikey'
]);
const SENSITIVE_VALUE_PATTERNS = [
  /\b(?:basic|bearer)\s+[a-z0-9._~+/=-]{8,}/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u
];

/**
 * Safe development default. Production may inject a redacting or encrypted
 * codec, but silently persisting credential-shaped JSON is never the fallback.
 */
export class StrictJsonAgentPersistencePayloadCodec
implements AgentPersistencePayloadCodec {
  public encode(
    value: AgentJsonValue,
    _context: AgentPersistencePayloadContext
  ): EncodedAgentPersistencePayload {
    assertSafeJson(value, '$', new Set<object>(), 0);
    assertPayloadSize(value);
    return {
      codecId: CODEC_ID,
      payload: cloneJson(value)
    };
  }

  public decode(
    encoded: EncodedAgentPersistencePayload,
    _context: AgentPersistencePayloadContext
  ): AgentJsonValue {
    if (encoded.codecId !== CODEC_ID) {
      throw new AgentPersistencePayloadRejectedError(
        'The persisted Agent payload requires an unavailable codec.'
      );
    }
    assertSafeJson(encoded.payload, '$', new Set<object>(), 0);
    assertPayloadSize(encoded.payload);
    return cloneJson(encoded.payload);
  }

}

function assertSafeJson(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number
): asserts value is AgentJsonValue {
  if (depth > 64) throw rejected(path);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (
      typeof value === 'string'
      && SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      throw rejected(path);
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw rejected(path);
    return;
  }
  if (typeof value !== 'object' || value === undefined) throw rejected(path);
  if (ancestors.has(value)) throw rejected(path);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        assertSafeJson(item, `${path}[${String(index)}]`, ancestors, depth + 1)
      );
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/gu, '');
      if (SENSITIVE_FIELD_NAMES.has(normalizedKey)) {
        throw rejected(`${path}.${key}`);
      }
      assertSafeJson(item, `${path}.${key}`, ancestors, depth + 1);
    }
  } finally {
    ancestors.delete(value);
  }
}

function cloneJson(value: AgentJsonValue): AgentJsonValue {
  return JSON.parse(JSON.stringify(value)) as AgentJsonValue;
}

function assertPayloadSize(value: AgentJsonValue): void {
  if (
    Buffer.byteLength(JSON.stringify(value), 'utf8')
    > MAX_PROTECTED_AGENT_TURN_INPUT_SNAPSHOT_UTF8_BYTES
  ) {
    throw new AgentPersistencePayloadRejectedError(
      'Agent recovery payload exceeds the 256 KiB persistence limit.'
    );
  }
}


function rejected(path: string): AgentPersistencePayloadRejectedError {
  return new AgentPersistencePayloadRejectedError(
    `Agent recovery payload was rejected at ${path}; credentials and raw authorization must not be persisted.`
  );
}
