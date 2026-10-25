import path from 'node:path';
import { migrateModelCapabilityDatabaseName } from '../model/capability/ModelCapabilityDatabaseNaming.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--data-root' || !args[1] || !path.isAbsolute(args[1])) {
  console.error('Usage: normalize-model-database --data-root <absolute stopped-runtime data root>');
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(migrateModelCapabilityDatabaseName(args[1]))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
