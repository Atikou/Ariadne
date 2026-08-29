import path from 'node:path';

import { migrateAgentControlV6ToV7 } from '../adapters/persistence/AgentControlV6ToV7Migration.js';

const args = process.argv.slice(2);
const dataRootIndex = args.indexOf('--data-root');
const rawDataRoot = dataRootIndex >= 0 ? args[dataRootIndex + 1] : undefined;

if (!rawDataRoot || !path.isAbsolute(rawDataRoot)) {
  console.error('Usage: migrate-agent-control-v6-v7 --data-root <absolute Ariadne runtime data root>');
  process.exitCode = 2;
} else {
  try {
    const result = migrateAgentControlV6ToV7(path.resolve(rawDataRoot));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
