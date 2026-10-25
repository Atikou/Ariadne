import path from 'node:path';
import { migrateProductivityV1ToV2 } from '../adapters/persistence/ProductivityV1ToV2Migration.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--data-root' || !args[1] || !path.isAbsolute(args[1])) {
  console.error('Usage: migrate-productivity-v1-v2 --data-root <absolute Ariadne runtime data root>'); process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(migrateProductivityV1ToV2(args[1]), null, 2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
