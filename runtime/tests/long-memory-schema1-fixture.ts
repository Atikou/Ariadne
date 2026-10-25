import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
/** Creates released Schema 1 vector rows solely to verify preservation/audit.
 * Production indexing no longer writes or reads this authority table. */
export function seedReleasedMemoryVector(root:string,memoryId:string,version=1):void {
  const database=new DatabaseSync(path.join(root,'data/long-memory/long-memory.db'));
  try {database.prepare('INSERT INTO long_memory_vectors VALUES (?,?,?,?,?)').run(memoryId,version,'space-a',2,'[1,0]');}
  finally {database.close();}
}
export function releasedMemoryVectors(root:string):readonly unknown[] {
  const database=new DatabaseSync(path.join(root,'data/long-memory/long-memory.db'),{readOnly:true});
  try {return database.prepare('SELECT * FROM long_memory_vectors').all();} finally {database.close();}
}
