import { readFileSync } from 'node:fs';

import {
  runtimeBuildManifestSchema,
  type RuntimeBuildManifest
} from '@ariadne/protocol/host';

export function readRuntimeBuildManifest(manifestPath: string): RuntimeBuildManifest {
  return runtimeBuildManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, 'utf8'))
  );
}
