import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runtimeBuildManifestSchema,
  type RuntimeBuildManifest,
} from "@ariadne/protocol/host";

export function readOwnRuntimeBuildManifest(): RuntimeBuildManifest {
  const manifestPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "runtime-build.json",
  );
  return runtimeBuildManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
}
