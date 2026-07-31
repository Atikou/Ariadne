import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(runtimeRoot, "dist");
const manifestPath = join(distRoot, "runtime-build.json");
const runtimePackage = JSON.parse(
  await readFile(join(runtimeRoot, "package.json"), "utf8"),
);
const files = (await listJavaScriptFiles(distRoot))
  .map((path) => ({
    path,
    relativePath: relative(distRoot, path).split(sep).join("/"),
  }))
  .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
const hash = createHash("sha256");

for (const file of files) {
  const content = await readFile(file.path);
  hash.update(file.relativePath);
  hash.update("\0");
  hash.update(String(content.byteLength));
  hash.update("\0");
  hash.update(content);
  hash.update("\0");
}

const manifest = {
  schemaVersion: 1,
  runtimeVersion: runtimePackage.version,
  fingerprint: hash.digest("hex"),
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

async function listJavaScriptFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJavaScriptFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}
