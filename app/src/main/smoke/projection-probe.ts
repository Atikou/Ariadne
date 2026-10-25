import type { BrowserWindow } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/** Load only the probe built into this smoke's isolated data directory. */
export async function installSmokeProjectionProbe(window: BrowserWindow): Promise<void> {
  const dataRoot = process.env.ARIADNE_SMOKE_USER_DATA, sourcePath = process.env.ARIADNE_SMOKE_PROJECTION_PROBE;
  if (process.env.ARIADNE_SMOKE_TEST !== '1' || !dataRoot || !sourcePath || !isAbsolute(dataRoot)
    || resolve(sourcePath) !== resolve(join(dataRoot, 'projection-probe.js'))) throw new Error('smoke_projection_probe_path_invalid');
  if ((await stat(sourcePath)).size > 1024 * 1024) throw new Error('smoke_projection_probe_byte_limit');
  await window.webContents.executeJavaScript(`${await readFile(sourcePath, 'utf8')};AriadneSmokeProjection.install();`);
}
