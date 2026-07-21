import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'dockview-react/dist/styles/dockview.css';
import { App } from './app/App';
import './app/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element was not found.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
