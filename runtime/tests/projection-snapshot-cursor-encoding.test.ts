import { expect, it } from 'vitest';
import { assertPublicProjectionPayloadSafe } from '@ariadne/protocol/public';
import { encodeProjectionCursorBytes, decodeProjectionCursorBytes } from '../src/adapters/persistence/ProjectionSnapshotCursorEncoding.js';
it('roundtrips arbitrary bytes without accidentally resembling a credential in a public opaque cursor', () => {
  for (const encoded of ['sk-AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA', `AKIA${'A'.repeat(16)}`]) {
    const bytes = Buffer.from(encoded, 'base64url');
    expect(() => assertPublicProjectionPayloadSafe({ bodyCursor: encoded })).toThrow('secret_forbidden');
    const token = encodeProjectionCursorBytes(bytes);
    expect(() => assertPublicProjectionPayloadSafe({ bodyCursor: `${token}.${token}` })).not.toThrow();
    expect(decodeProjectionCursorBytes(token)).toEqual(bytes);
  }
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  expect(decodeProjectionCursorBytes(encodeProjectionCursorBytes(bytes))).toEqual(Buffer.from(bytes));
});
it('rejects noncanonical aliases, invalid escapes and raw legacy segments without weakening plaintext safety', () => {
  for (const value of ['c1_A', 'c1_YR', 'c1_-', 'c1__', 'c1__x', 'c1_YQ=', 'YQ']) expect(decodeProjectionCursorBytes(value)).toBeNull();
  expect(() => assertPublicProjectionPayloadSafe({ content: 'sk-AAAAAAAAAAAAAAAAAAAA' })).toThrow('secret_forbidden');
  expect(() => assertPublicProjectionPayloadSafe({ content: 'password=PRIVATE' })).toThrow('secret_forbidden');
});
