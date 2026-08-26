import type { PublicError, Result } from '@shared/contract';

export class PublicResultError extends Error {
  constructor(readonly publicError: PublicError) {
    super(publicError.message);
    this.name = 'PublicResultError';
  }
}

export function unwrapPublicResult<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new PublicResultError(result.error);
}
