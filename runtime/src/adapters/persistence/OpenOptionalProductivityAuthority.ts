import { SqliteProductivityStore } from './SqliteProductivityStore.js';
import { classifySqliteAuthorityFault } from './SqliteAuthorityHealth.js';

/** The failed opener must release its owned connection and lease before a
 * known optional source fault can leave independent Core/Conversation usable. */
export function openOptionalProductivityAuthority(dataRoot: string): SqliteProductivityStore | undefined {
  try { return new SqliteProductivityStore(dataRoot); }
  catch (error) {
    if (classifySqliteAuthorityFault('productivity', error) === null) throw error;
    return undefined;
  }
}
