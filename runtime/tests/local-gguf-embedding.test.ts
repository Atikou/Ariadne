import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalGgufEmbeddingProvider } from "../src/context/EmbeddingService.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("LocalGgufEmbeddingProvider", () => {
  it("verifies the pinned model hash and enforces its vector dimension", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-embedding-"));
    temporaryRoots.push(root);
    const modelPath = path.join(root, "bge-m3.gguf");
    const bytes = Buffer.from("fixture-gguf");
    await writeFile(modelPath, bytes);
    let disposed = false;
    const provider = new LocalGgufEmbeddingProvider({
      modelId: "bge-m3-fixture",
      modelPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dimension: 3,
      runtimeFactory: async () => ({
        dimension: 3,
        async embed() { return [3, 4, 0]; },
        async dispose() { disposed = true; },
      }),
    });

    expect(provider.status()).toMatchObject({
      capability: "semantic",
      dimension: 3,
      remote: false,
      degraded: false,
    });
    expect(await provider.embedText("多语言语义")).toEqual([0.6, 0.8, 0]);
    await provider.dispose();
    expect(disposed).toBe(true);
  });

  it("fails closed when the configured model hash does not match", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-embedding-"));
    temporaryRoots.push(root);
    const modelPath = path.join(root, "bge-m3.gguf");
    await writeFile(modelPath, "unexpected");
    const provider = new LocalGgufEmbeddingProvider({
      modelId: "bge-m3-fixture",
      modelPath,
      sha256: "0".repeat(64),
      dimension: 3,
      runtimeFactory: async () => {
        throw new Error("must not load");
      },
    });

    await expect(provider.embedText("query")).rejects.toThrow(
      "embedding_model_integrity_mismatch",
    );
    expect(provider.status().degraded).toBe(true);
  });
});
