import { expect, it } from 'vitest';
import { PUBLIC_PROJECTION_GENESIS_DIGEST, verifyPublicProjectionMessageWindow,
  type PublicProjectionViewManifest } from '../src/public.js';

const manifest: PublicProjectionViewManifest = { pageContractVersion: '2.0', projectionContractVersion: '5.0',
  snapshotId: 'snapshot-1', streamId: 'stream-1', boundaryCursor: 0, boundaryDigest: PUBLIC_PROJECTION_GENESIS_DIGEST,
  scope: { kind: 'session', workspaceId: 'workspace-1', sessionId: 'session-1' }, selectedFeatures: ['runs'],
  capturedAt: '2032-01-01T00:00:00.000Z', expiresAt: '2032-01-01T00:05:00.000Z' };

it('correlates missing anchors with the exact snapshot and rejects an impossible latest-window anchor response', async () => {
  const result = { status: 'anchor_unavailable' as const, snapshotId: manifest.snapshotId };
  const request = { manifest, window: { kind: 'around' as const, anchorMessageId: 'message-missing', limit: 5 } };
  expect(await verifyPublicProjectionMessageWindow(request, result)).toEqual(result);
  await expect(verifyPublicProjectionMessageWindow(request, { ...result, snapshotId: 'other-snapshot' }))
    .rejects.toThrow('message_window_request_mismatch');
  await expect(verifyPublicProjectionMessageWindow({ manifest, window: { kind: 'latest', limit: 5 } }, result))
    .rejects.toThrow('message_window_request_mismatch');
});
