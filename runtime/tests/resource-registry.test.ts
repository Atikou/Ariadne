import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import { ResourceRegistry } from "../src/resources/ResourceRegistry.js";

const roots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content-addressed Resource Registry", () => {
  it("deduplicates bytes while preserving opaque ownership records and no local paths", async () => {
    const { registry } = await fixture();
    const input = {
      name: "architecture.md",
      mediaType: "text/markdown",
      bytes: Buffer.from("# Architecture", "utf8"),
      lifecycle: "session" as const,
      sensitivity: "workspace" as const,
      provenance: { origin: "user_upload", sourceId: "upload-1", summary: "architecture" },
    };
    const first = await registry.registerBytes({
      ...input,
      owner: { type: "session", id: "session-1" },
    });
    const second = await registry.registerBytes({
      ...input,
      owner: { type: "session", id: "session-2" },
    });

    expect(first.resourceId).not.toBe(second.resourceId);
    expect(first.hash).toBe(second.hash);
    expect(await registry.readBytes(first.resourceId)).toEqual(input.bytes);
    expect(JSON.stringify(first)).not.toMatch(/[A-Z]:\\|relative_path|objectsRoot/iu);
    expect(registry.list({ ownerType: "session", ownerId: "session-1" }))
      .toEqual([first]);

    expect(await registry.delete(first.resourceId)).toBe(true);
    expect(await registry.readBytes(second.resourceId)).toEqual(input.bytes);
    expect(await registry.delete(second.resourceId)).toBe(true);
    await expect(registry.readBytes(second.resourceId)).rejects.toThrow("resource_not_found");
  });

  it("expires only resources whose declared lifetime elapsed", async () => {
    const { registry } = await fixture();
    const expired = await registry.registerBytes({
      name: "temporary.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("temporary"),
      owner: { type: "run", id: "run-1" },
      lifecycle: "temporary",
      sensitivity: "sensitive",
      provenance: { origin: "tool" },
      expiresAt: "2026-01-01T00:00:00.000Z",
    });
    await registry.registerBytes({
      name: "persistent.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("persistent"),
      owner: { type: "user", id: "user-1" },
      lifecycle: "persistent",
      sensitivity: "workspace",
      provenance: { origin: "user_upload" },
    });

    expect(await registry.deleteExpired("2026-07-24T00:00:00.000Z")).toBe(1);
    expect(registry.get(expired.resourceId)).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });

  it("updates governance metadata without changing content identity or ownership", async () => {
    const { registry } = await fixture();
    const created = await registry.registerBytes({
      name: "draft.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("content"),
      owner: { type: "session", id: "session-1" },
      lifecycle: "session",
      sensitivity: "workspace",
      provenance: { origin: "user_upload", summary: "draft" },
    });

    const updated = registry.update(created.resourceId, {
      name: "approved.txt",
      lifecycle: "persistent",
      sensitivity: "sensitive",
      provenanceSummary: null,
      expiresAt: "2027-01-01T00:00:00.000Z",
    });

    expect(updated).toMatchObject({
      resourceId: created.resourceId,
      name: "approved.txt",
      hash: created.hash,
      owner: created.owner,
      lifecycle: "persistent",
      sensitivity: "sensitive",
      expiresAt: "2027-01-01T00:00:00.000Z",
      provenance: { origin: "user_upload" },
    });
    expect(updated?.provenance).not.toHaveProperty("summary");
    expect(await registry.readBytes(created.resourceId)).toEqual(Buffer.from("content"));
  });
});

async function fixture(): Promise<{ registry: ResourceRegistry }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-resources-"));
  roots.push(root);
  const database = new DatabaseManager(root);
  databases.push(database);
  return { registry: new ResourceRegistry(database.connection, root) };
}
