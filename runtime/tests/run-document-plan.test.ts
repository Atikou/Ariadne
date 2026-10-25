import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalPublicProjectionJson, MAX_RUN_DOCUMENT_LEAF_BYTES, RunDocumentItemAssembler,
  verifyRunDocumentHeader, verifyRunDocumentLeaf, runDocumentHeaderData, runDocumentLeafData,
  verifyRunDocumentItemMetadata, runDocumentItemMetadata } from '@ariadne/protocol/public';
import { RunDocumentPlan, type RunDocumentSource } from '../src/projection/RunDocumentPlan.js';

const at = '2032-01-01T00:00:00.000Z';
function source(count = 17): RunDocumentSource {
  return { summary: { runId: 'document-run', sessionId: 'document-session', version: 4,
    title: '模拟容量数据', status: 'running', label: '模拟容量数据', updatedAt: at,
    toolActivityCount: 0, queuedInputCount: count, claimedInputCount: 0, interactionMessageCount: 1 },
    toolActivities: [], inbox: Array.from({ length: count }, (_, index) => ({ inputId: `input-${index}`,
      messageId: `message-${index}`, version: 1, delivery: 'next_turn' as const, content: '汉字🙂'.repeat(20_000),
      state: 'queued' as const, queuedAt: at, updatedAt: at })),
    interactionMessages: [{ messageId: 'large-message', sessionId: 'document-session', runId: 'document-run',
      version: 1, role: 'assistant', content: '长正文🙂'.repeat(200_000), status: 'completed', createdAt: at, updatedAt: at }] };
}
describe('immutable bounded Run document plan', () => {
  it('preserves a multi-megabyte Run and a single multi-chunk interaction without enlarging released DTOs', async () => {
    const input = source(); const plan = new RunDocumentPlan(input);
    expect(Buffer.byteLength(canonicalPublicProjectionJson(input))).toBeGreaterThan(4 * 1024 * 1024);
    await expect(verifyRunDocumentHeader(plan.header)).resolves.toEqual(plan.header);
    expect(Buffer.byteLength(canonicalPublicProjectionJson(plan.header))).toBeLessThan(4_096);
    let maxLeaf = 0;
    for (const kind of ['inbox', 'interactionMessages'] as const) {
      for (let index = 0; index < input[kind].length; index++) {
        const assembler = new RunDocumentItemAssembler(plan.header, kind, index); let completed = null;
        for (const leaf of plan.itemLeaves(kind, index)) {
          maxLeaf = Math.max(maxLeaf, Buffer.byteLength(canonicalPublicProjectionJson(leaf)));
          completed = await assembler.accept(leaf);
          if (leaf.descriptor.chunkOrdinal < leaf.descriptor.chunkCount - 1) expect(completed).toBeNull();
        }
        expect(completed).toEqual({ collection: kind, value: input[kind][index] });
      }
    }
    expect(maxLeaf).toBeLessThan(MAX_RUN_DOCUMENT_LEAF_BYTES);
    expect(plan.header.collections.interactionMessages.leafCount).toBeGreaterThan(1);
  });
  it('rejects substituted bytes, siblings, duplicate or reordered chunks, and foreign versions', async () => {
    const plan = new RunDocumentPlan(source(0)); const leaves = [...plan.itemLeaves('interactionMessages', 0)];
    const first = leaves[0]!;
    const changedBytes = Buffer.from(first.contentBase64, 'base64'); changedBytes[0] = changedBytes[0]! ^ 1;
    await expect(verifyRunDocumentLeaf(plan.header, { ...first, contentBase64: changedBytes.toString('base64') })).rejects.toThrow('chunk_digest_mismatch');
    await expect(verifyRunDocumentLeaf(plan.header, { ...first, siblings: first.siblings.map(() => `sha256:${'f'.repeat(64)}`) })).rejects.toThrow('proof_mismatch');
    await expect(verifyRunDocumentLeaf(plan.header, { ...first, descriptor: { ...first.descriptor, runVersion: 5 } })).rejects.toThrow('owner_mismatch');
    const assembler = new RunDocumentItemAssembler(plan.header, 'interactionMessages', 0);
    await expect(assembler.accept(leaves[1])).rejects.toThrow('sequence_mismatch');
    await expect(assembler.accept(first)).resolves.toBeNull();
    await expect(assembler.accept(first)).rejects.toThrow('sequence_mismatch');
    await expect(verifyRunDocumentLeaf(plan.header, { ...first, siblings: [] })).rejects.toThrow('proof_incomplete');
  });
  it('does not permit protected payloads to evade validation through encoding or drifting source data', () => {
    const input = source(1); const plan = new RunDocumentPlan(input);
    (input.inbox[0] as { content: string }).content = 'later content';
    expect(() => [...plan.itemLeaves('inbox', 0)]).toThrow('source_drift');
    const unsafe = source(1); (unsafe.inbox[0] as { content: string }).content = 'password=private-credential';
    expect(() => new RunDocumentPlan(unsafe)).toThrow('public_projection_secret_forbidden');
    const foreign = source(0); (foreign.interactionMessages[0] as { sessionId: string }).sessionId = 'other-session';
    expect(() => new RunDocumentPlan(foreign)).toThrow('owner_mismatch');
  });
  it('binds empty collections and summary counts to the document identity', async () => {
    const input = source(0); const plan = new RunDocumentPlan(input);
    await expect(verifyRunDocumentHeader({ ...plan.header, summary: { ...plan.header.summary, version: 5 } })).rejects.toThrow('header_digest_mismatch');
    expect(() => new RunDocumentPlan({ ...input, summary: { ...input.summary, queuedInputCount: 1 } })).toThrow();
    const queued = source(1);
    expect(() => new RunDocumentPlan({ ...queued, summary: { ...queued.summary, queuedInputCount: 0, claimedInputCount: 1 } })).toThrow('inbox_counts_mismatch');
    (input.summary as { version: number }).version = 5;
    expect(() => [...plan.itemLeaves('interactionMessages', 0)]).toThrow('source_drift');
  });
  it('validates decoded semantic payloads even when an untrusted sender recomputes every digest', async () => {
    const input = source(1); const plan = new RunDocumentPlan(input); const first = [...plan.itemLeaves('inbox', 0)][0]!;
    const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    const bytes = Buffer.from(canonicalPublicProjectionJson({ collection: 'inbox', value: {
      ...input.inbox[0], content: 'password=private-credential'
    } }), 'utf8');
    const descriptor = { ...first.descriptor, itemBytes: bytes.length, itemDigest: hash(bytes),
      chunkCount: 1, chunkBytes: bytes.length, chunkDigest: hash(bytes) };
    const { documentDigest: _old, ...data } = plan.header;
    const changed = { ...data, collections: { ...data.collections,
      inbox: { itemCount: 1, leafCount: 1, merkleRoot: hash(runDocumentLeafData(descriptor)) } } };
    const header = { ...changed, documentDigest: hash(runDocumentHeaderData(changed)) };
    const assembler = new RunDocumentItemAssembler(header, 'inbox', 0);
    await expect(assembler.accept({ descriptor, contentBase64: bytes.toString('base64'), siblings: [] }))
      .rejects.toThrow('public_projection_secret_forbidden');
  });
  it('proves exact Inbox metadata without loading its content and rejects a substituted delivery or state', async () => {
    const input = source(1); const plan = new RunDocumentPlan(input); const leaf = [...plan.itemLeaves('inbox', 0)][0]!;
    const metadata = runDocumentItemMetadata({ collection: 'inbox', value: input.inbox[0]! });
    expect('content' in metadata.value).toBe(false);
    await expect(verifyRunDocumentItemMetadata(plan.header, leaf.descriptor, leaf.siblings, metadata)).resolves.toEqual(metadata);
    await expect(verifyRunDocumentItemMetadata(plan.header, leaf.descriptor, leaf.siblings,
      { ...metadata, value: { ...metadata.value, delivery: 'next_step' } })).rejects.toThrow('metadata_digest_mismatch');
    await expect(verifyRunDocumentItemMetadata(plan.header, leaf.descriptor, leaf.siblings,
      { ...metadata, value: { ...metadata.value, state: 'claimed', claimedTurnId: 'claimed-turn' } })).rejects.toThrow('metadata_digest_mismatch');
  });
});
