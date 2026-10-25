// Dockview 7.0.2 owns resize listeners but leaves their debounce timer alive.
// Remove this bounded vendor repair when the locked upstream version owns both.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, 'node_modules/dockview-core');
const version = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).version;
if (version !== '7.0.2') throw new Error('Reassess the Dockview resize lifecycle repair for version ' + version);
const hashes = {
  'dist/esm/dom.js': '2be92207b8c4542e96542cabad0ccc419fc97948af0071fb592feca7f6b6bbb0',
  'dist/cjs/dom.js': '4dd404252c7aa6fb9a42df2efbcca56397433ace52a18e4eb45f4f2acd4f7c5f',
  'dist/package/main.cjs.js': '9088debeeb8304712df57a4cca7326db36352f83d302c977a86b26ca8761d18f',
  'dist/package/main.esm.mjs': '1864a12a126640c35296b2ed75f3bbb41ad5f5095d06d5faada53bf34293f560'
};
const digest = text => createHash('sha256').update(text).digest('hex');
const pending = [];
for (const [relative, expected] of Object.entries(hashes)) {
  const path = resolve(directory, relative);
  const source = readFileSync(path, 'utf8');
  const commonJs = relative === 'dist/cjs/dom.js';
  const original = commonJs ? `function onDidWindowResizeEnd(element, cb) {
    var resizeTimeout;
    var disposable = new lifecycle_1.CompositeDisposable((0, events_1.addDisposableListener)(element, 'resize', function () {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(function () {
            cb();
        }, DEBOUCE_DELAY);
    }));
    return disposable;
}` : `function onDidWindowResizeEnd(element, cb) {
    let resizeTimeout;
    const disposable = new CompositeDisposable(addDisposableListener(element, 'resize', () => {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            cb();
        }, DEBOUCE_DELAY);
    }));
    return disposable;
}`;
  const composite = commonJs ? 'lifecycle_1.CompositeDisposable' : 'CompositeDisposable';
  const listener = commonJs ? '(0, events_1.addDisposableListener)' : 'addDisposableListener';
  const corrected = `function onDidWindowResizeEnd(element, cb) {
    let resizeTimeout;
    let disposed = false;
    return new ${composite}(${listener}(element, 'resize', () => {
        if (disposed) return;
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            resizeTimeout = undefined;
            if (!disposed) cb();
        }, DEBOUCE_DELAY);
    }), { dispose() {
        disposed = true;
        clearTimeout(resizeTimeout);
        resizeTimeout = undefined;
    } });
}`;
  if (digest(source) === expected && source.split(original).length === 2) {
    pending.push({ path, source: source.replace(original, corrected) });
  } else if (source.split(corrected).length !== 2 || digest(source.replace(corrected, original)) !== expected) {
    throw new Error('Unexpected Dockview contents; no files changed: ' + relative);
  }
}
// Check every input before changing any file; repeat installation is idempotent.
for (const item of pending) writeFileSync(item.path, item.source);
console.log('Dockview resize lifecycle verified (7.0.2; ' + pending.length + ' files repaired).');
