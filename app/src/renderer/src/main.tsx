import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'dockview-react/dist/styles/dockview.css';
import { App } from './app/App';
import { applicationProfileComponents } from '@shared/application-profile';
import { createUiModuleRegistry } from './core/modules/ui-module-registry';
import { getWindowRendererCompositionRoot } from './core/services/renderer-composition-root';
import './app/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element was not found.');
void startRenderer();

async function startRenderer(): Promise<void> {
  const applicationProfile = await window.ariadne.system.getApplicationProfile();
  const composition = getWindowRendererCompositionRoot(
    window.ariadne,
    window.localStorage,
    applicationProfile
  );
  composition.installWindowLifecycle(window);
  void composition.start();
  const capabilities = await window.ariadne.system.getCapabilityStatuses().catch(
    (error: unknown) => {
      console.error('UI capability snapshot could not be loaded.', error);
      return [];
    }
  );
  const registry = createUiModuleRegistry(
    capabilities,
    applicationProfileComponents(applicationProfile, 'ui')
  );
  createRoot(root!).render(
    <StrictMode>
      <App services={composition.services} registry={registry} />
    </StrictMode>
  );
}
