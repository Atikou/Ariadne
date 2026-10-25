import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Shared disk boundary only; each private repository retains its own schema and CAS. */
export async function writeAtomicPrivateFile(filePath: string, raw: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, raw, { encoding: 'utf8', mode: 0o600, flush: true });
  await rename(temporary, filePath);
}
