const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Arch } = require('builder-util');

/** Electron rebuild does not run node-pty's postinstall. Reuse that owning
 * installer after rebuild/extraction and before app files enter ASAR. */
function restoreNativePtyAssets(architecture) {
  if (process.platform !== 'win32') return;
  if (!['x64', 'arm64'].includes(architecture)) throw new Error('Unsupported native PTY asset architecture.');
  const packageRoot = path.dirname(require.resolve('node-pty/package.json'));
  const release = path.join(packageRoot, 'build', 'Release');
  if (fs.realpathSync.native(packageRoot) !== packageRoot || !fs.statSync(release).isDirectory())
    throw new Error('Native PTY generated directory is not canonical.');
  // The original installer recursively cleans this generated directory. Reject
  // any alias before invoking it, so its cleanup cannot leave the package.
  function verify(directory) {
    if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync.native(directory) !== directory)
      throw new Error('Native PTY generated directory contains an alias.');
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Native PTY generated directory contains an alias.');
      if (entry.isDirectory()) verify(path.join(directory, entry.name));
    }
  }
  verify(release);
  const result = spawnSync(process.execPath, [path.join(packageRoot, 'scripts', 'post-install.js')], {
    cwd: packageRoot, windowsHide: true, stdio: 'inherit', env: { ...process.env, npm_config_arch: architecture }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Original native PTY asset installation failed.');
  for (const name of ['conpty.dll', 'OpenConsole.exe'])
    if (!fs.statSync(path.join(release, 'conpty', name)).isFile()) throw new Error('Native PTY asset is missing: ' + name);
}

module.exports = context => restoreNativePtyAssets(Arch[context.arch]);
if (require.main === module) restoreNativePtyAssets(process.arch);
