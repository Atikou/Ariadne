import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'dockview-react/dist/styles/dockview.css';
import { App } from './app/App';
import { createUiModuleRegistry } from './core/modules/ui-module-registry';
import { getWindowRendererCompositionRoot } from './core/services/renderer-composition-root';
import './app/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element was not found.');
const composition = getWindowRendererCompositionRoot(window.ariadne, window.localStorage);
composition.installWindowLifecycle(window);
void startRenderer();

async function startRenderer(): Promise<void> {
  void composition.start();
  const capabilities = await window.ariadne.system.getCapabilityStatuses().catch(
    (error: unknown) => {
      console.error('UI capability snapshot could not be loaded.', error);
      return [];
    }
  );
  const registry = createUiModuleRegistry(capabilities);
  createRoot(root!).render(
    <StrictMode>
      <App services={composition.services} registry={registry} />
    </StrictMode>
  );
}
