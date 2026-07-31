import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashContent } from "../src/tools/file/hash.js";
import { readFileTool, writeFileTool } from "../src/tools/fileTools.js";
import type { ToolContext } from "../src/tools/types.js";

const roots: string[] = [];

describe("bounded file tools", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("requires an explicit cursor for a large file instead of loading it whole", async () => {
    const root = workspace();
    const content = Array.from(
      { length: 10_000 },
      (_, index) => `line-${String(index + 1).padStart(5, "0")}`,
    ).join("\n");
    writeFileSync(path.join(root, "large.txt"), content, "utf-8");

    const output = await readFileTool.execute(
      readFileTool.inputSchema.parse({ path: "large.txt" }),
      context(root),
    );

    expect(output).toMatchObject({
      found: true,
      path: "large.txt",
      content: "",
      rangeRequired: true,
      outcome: { class: "observation_failure", kind: "range_required" },
    });
  });

  it("returns line cursors, total lines, eof and sha256 for a bounded range", async () => {
    const root = workspace();
    const content = Array.from(
      { length: 500 },
      (_, index) => `line-${String(index + 1).padStart(3, "0")}`,
    ).join("\n");
    writeFileSync(path.join(root, "lines.txt"), content, "utf-8");

    const output = await readFileTool.execute(
      readFileTool.inputSchema.parse({
        path: "lines.txt",
        startLine: 101,
        lineCount: 20,
      }),
      context(root),
    );

    expect(output).toMatchObject({
      found: true,
      startLine: 101,
      endLine: 120,
      lineCount: 20,
      requestedLineCount: 20,
      totalLines: 500,
      nextStartLine: 121,
      eof: false,
      sha256: hashContent(content),
    });
    expect(output.content).toContain("line-101");
    expect(output.content).toContain("line-120");
  });

  it("supports byte cursors for minified single-line files", async () => {
    const root = workspace();
    writeFileSync(path.join(root, "minified.js"), "0123456789".repeat(500), "utf-8");

    const output = await readFileTool.execute(
      readFileTool.inputSchema.parse({
        path: "minified.js",
        byteOffset: 100,
        maxBytes: 50,
      }),
      context(root),
    );

    expect(output).toMatchObject({
      byteOffset: 100,
      bytesRead: 50,
      nextByteOffset: 150,
      eof: false,
      truncated: true,
    });
    expect(output.content).toHaveLength(50);
  });

  it("refuses blind overwrite and commits a hash-guarded replacement without temp residue", async () => {
    const root = workspace();
    const target = path.join(root, "target.txt");
    writeFileSync(target, "before", "utf-8");

    await expect(writeFileTool.execute(
      writeFileTool.inputSchema.parse({
        path: "target.txt",
        content: "after",
        backup: false,
      }),
      context(root),
    )).rejects.toThrow("requires expectedSha256");

    const output = await writeFileTool.execute(
      writeFileTool.inputSchema.parse({
        path: "target.txt",
        content: "after",
        expectedSha256: hashContent("before"),
        backup: false,
      }),
      context(root),
    );

    expect(output).toMatchObject({
      path: "target.txt",
      beforeHash: hashContent("before"),
      afterHash: hashContent("after"),
      isNew: false,
    });
    expect(readFileSync(target, "utf-8")).toBe("after");
    expect(readdirSync(root).filter((name) => name.includes(".ariadne-"))).toEqual([]);
  });
});

function workspace(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "ariadne-file-tool-"));
  roots.push(root);
  return root;
}

function context(workspaceRoot: string): ToolContext {
  return { workspaceRoot } as ToolContext;
}
