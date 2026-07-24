import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

async function collectTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(absolute);
    return entry.name.endsWith(".ts") ? [absolute] : [];
  }));
  return nested.flat();
}

function relativeImportSpecifiers(source: string): string[] {
  return [...source.matchAll(
    /(?:from\s+|import\s*\()\s*["'](\.[^"']+)["']/gu,
  )].map((match) => match[1]!);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

describe("Ariadne Runtime test boundary", () => {
  it("keeps every relative test dependency inside the current Runtime workspace", async () => {
    const runtimeRoot = process.cwd();
    const testRoot = path.join(runtimeRoot, "tests");
    const offenders: string[] = [];

    for (const file of await collectTypeScriptFiles(testRoot)) {
      const source = await readFile(file, "utf8");
      for (const specifier of relativeImportSpecifiers(source)) {
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!isInside(runtimeRoot, resolved)) {
          offenders.push(`${path.relative(runtimeRoot, file)} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("uses the current Vitest workspace instead of invoking a foreign test runner", async () => {
    const runtimeRoot = process.cwd();
    const manifest = JSON.parse(
      await readFile(path.join(runtimeRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const testSources = await Promise.all(
      (await collectTypeScriptFiles(path.join(runtimeRoot, "tests")))
        .map((file) => readFile(file, "utf8")),
    );

    expect(manifest.scripts?.test).toBe("vitest run");
    expect(testSources.join("\n")).not.toMatch(/\bnode:test\b|\bnode:assert\b/u);
  });
});
