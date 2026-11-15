import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { blockCompetingServiceWorker } from './swGuard.ts';
import './styles.css';

blockCompetingServiceWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
);
