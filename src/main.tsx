import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// Self-hosted, so the app has no third-party font request to make and the
// figures are never rendered in a fallback face while a CDN answers. One
// variable face covers the whole scale, 400 prose through 900 seat names.
import '@fontsource-variable/archivo/wdth.css';
import './styles/base.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
