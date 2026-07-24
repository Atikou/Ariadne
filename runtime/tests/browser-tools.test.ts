import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DatabaseManager } from "../src/context/DatabaseManager.js";
import type { HostCapabilityBroker } from "../src/host/HostCapabilityBroker.js";
import { ResourceRegistry } from "../src/resources/ResourceRegistry.js";
import { ToolRegistry } from "../src/tools/ToolRegistry.js";
import { createBrowserToolProvider } from "../src/tools/browserTools.js";

const roots: string[] = [];
const databases: DatabaseManager[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Browser ToolContract provider", () => {
  it("registers screenshots in the Resource Registry instead of returning base64", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ariadne-browser-tool-"));
    roots.push(root);
    const database = new DatabaseManager(root);
    databases.push(database);
    const resources = new ResourceRegistry(database.connection, root);
    const host: HostCapabilityBroker = {
      async request(operation) {
        expect(operation).toEqual({ kind: "browser.screenshot" });
        return {
          name: "screen.png",
          mediaType: "image/png",
          dataBase64: Buffer.from("png-bytes").toString("base64"),
        };
      },
    };
    const registry = new ToolRegistry()
      .registerProvider(createBrowserToolProvider())
      .setDefaultContext({ hostCapabilities: host, resources });

    const result = await registry.run("browser_screenshot", {}, {
      workspaceRoot: root,
      requestId: "run-1",
      allowedPermissions: ["read"],
    });

    expect(result.ok).toBe(true);
    expect(result.output).toMatchObject({
      resource: {
        name: "screen.png",
        mediaType: "image/png",
        owner: { type: "run", id: "run-1" },
        lifecycle: "run",
        sensitivity: "sensitive",
      },
    });
    expect(JSON.stringify(result.output)).not.toContain("dataBase64");
    const [resource] = resources.list({ ownerType: "run", ownerId: "run-1" });
    expect(await resources.readBytes(resource!.resourceId)).toEqual(Buffer.from("png-bytes"));
  });
});
