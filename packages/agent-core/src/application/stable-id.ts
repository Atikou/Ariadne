import { AgentRunInvariantError } from '../domain/errors.js';
import { assertCanonicalPublicId } from '../domain/values.js';

/** Derives a compact public-representable identity from immutable components. */
export async function deriveStableAgentId(
  namespace: string,
  ...components: readonly string[]
): Promise<string> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(namespace)) {
    throw new AgentRunInvariantError('Stable ID namespace is invalid.');
  }
  components.forEach((component, index) =>
    assertCanonicalPublicId(component, `stableId.components[${String(index)}]`)
  );
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new AgentRunInvariantError(
      'Stable identity derivation requires the standard Web Crypto API.'
    );
  }
  const canonical = components
    .map((component) => `${String(component.length)}:${component}`)
    .join('|');
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${namespace}|${canonical}`)
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${namespace}:${hex}`;
}
