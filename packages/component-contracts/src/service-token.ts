declare const serviceTokenValue: unique symbol;

/** A compile-time typed identifier. Runtime identity is the canonical id. */
export interface ServiceToken<T> {
  readonly id: string;
  readonly [serviceTokenValue]?: T;
}

export function serviceToken<T>(id: string): ServiceToken<T> {
  if (!isCanonicalComponentId(id)) throw new Error(`component_service_token_invalid:${id}`);
  return Object.freeze({ id }) as ServiceToken<T>;
}

export function isCanonicalComponentId(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value);
}
