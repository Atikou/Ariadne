import path from 'node:path';
import { migrateCommunicationContract } from '../adapters/persistence/CommunicationContractMigration.js';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--data-root' || !args[1] || !path.isAbsolute(args[1])) {
  console.error('Usage: normalize-communication-contract --data-root <absolute stopped-runtime data root>');
  process.exitCode = 2;
} else {
  try { console.log(JSON.stringify(migrateCommunicationContract(args[1]))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
