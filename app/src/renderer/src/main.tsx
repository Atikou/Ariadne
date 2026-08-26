import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'dockview-react/dist/styles/dockview.css';
import { App } from './app/App';
import { getWindowRendererCompositionRoot } from './core/services/renderer-composition-root';
import './app/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element was not found.');
const composition = getWindowRendererCompositionRoot(window.ariadne, window.localStorage);
composition.installWindowLifecycle(window);
void composition.start();

createRoot(root).render(
  <StrictMode>
    <App services={composition.services} />
  </StrictMode>
);
