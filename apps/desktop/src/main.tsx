import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root';
import { installGlobalDiagnostics } from './lib/diagnosticLog';
import './styles.css';
import './qhd.css';
import './progress.css';

installGlobalDiagnostics();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
