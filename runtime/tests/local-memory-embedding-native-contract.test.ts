import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalGgufEmbeddingProvider } from '../src/adapters/embedding/LocalMemoryEmbedding.js';

const native = vi.hoisted(() => ({ getLlama: vi.fn() }));
vi.mock('node-llama-cpp', () => ({ getLlama: native.getLlama }));
const roots: string[] = [];
function provider() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ariadne-native-embedding-')); roots.push(directory);
  const modelPath = path.join(directory, 'fixture.gguf'); const bytes = Buffer.from('adapter contract fixture'); writeFileSync(modelPath, bytes);
  return new LocalGgufEmbeddingProvider({ modelId: 'fixture', modelPath, sha256: createHash('sha256').update(bytes).digest('hex'), dimension: 2 });
}
function runtime() {
  const order: string[] = []; const parts: number[][] = [];
  const context = { dispose: vi.fn(async () => { order.push('context'); }), getEmbeddingFor: vi.fn(async (tokens: number[]) => {
    parts.push(tokens); return { vector: tokens.includes(9) ? [0, 1] : [1, 0] };
  }) };
  const model = { embeddingVectorSize: 2, trainContextSize: 8,
    tokenize: vi.fn((_text: string, _special: boolean) => [1,2,3,4,5,6,7,8,9]),
    createEmbeddingContext: vi.fn(async (_options: unknown) => context), dispose: vi.fn(async () => { order.push('model'); }) };
  const llama = { loadModel: vi.fn(async (_options: unknown) => model), dispose: vi.fn(async () => { order.push('llama'); }) };
  native.getLlama.mockResolvedValue(llama); return { order, parts, context, model, llama };
}
beforeEach(() => native.getLlama.mockReset());
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('local embedding adapter against the native library contract', () => {
  it('preserves every token past the model context limit and pools using actual token counts', async () => {
    const r = runtime(); const embedding = provider(); const vector = await embedding.embedText('long memory');
    expect(r.parts).toEqual([[1,2,3,4],[5,6,7,8],[9]]);
    expect(r.model.tokenize).toHaveBeenCalledWith('long memory', false);
    expect(r.model.createEmbeddingContext).toHaveBeenCalledWith({ contextSize: 8 });
    expect(vector[0]).toBeCloseTo(8 / Math.sqrt(65)); expect(vector[1]).toBeCloseTo(1 / Math.sqrt(65));
    expect(native.getLlama).toHaveBeenCalledWith({ build: 'never', skipDownload: true, progressLogs: false });
    await embedding.dispose(); expect(r.order).toEqual(['context','model','llama']);
  });
  it('disposes every opened native resource even if one cleanup fails', async () => {
    const r = runtime(); const embedding = provider(); await embedding.embedText('query');
    r.context.dispose.mockImplementation(async () => { r.order.push('context'); throw new Error('context close failed'); });
    await expect(embedding.dispose()).rejects.toThrow('embedding_dispose_failed');
    expect(r.order).toEqual(['context','model','llama']);
  });
  it('releases the model and library when dimensions fail before a context is created', async () => {
    const r = runtime(); r.model.embeddingVectorSize = 3; const embedding = provider();
    await expect(embedding.embedText('query')).rejects.toThrow('embedding_model_dimension_mismatch');
    expect(r.model.createEmbeddingContext).not.toHaveBeenCalled(); expect(r.order).toEqual(['model','llama']);
    expect(embedding.status().degraded).toBe(true);
    r.model.embeddingVectorSize = 2; await embedding.embedText('retry'); expect(embedding.status().degraded).toBe(false);
    await embedding.dispose();
  });
  it('releases initialized native resources when context creation fails', async () => {
    const r = runtime(); r.model.createEmbeddingContext.mockRejectedValueOnce(new Error('context initialization failed'));
    const embedding = provider(); await expect(embedding.embedText('query')).rejects.toThrow('context initialization failed');
    expect(r.order).toEqual(['model','llama']);
  });
});
