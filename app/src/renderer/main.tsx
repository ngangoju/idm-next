import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { DetailWindow } from './DetailWindow.tsx';
import { followTheme } from './client.ts';
import './styles.css';

// Before the first render, so the page never paints in the wrong theme.
followTheme();

// One bundle, two windows. A `?detail=<id>` window shows that download's
// progress and nothing else; without it this is the list.
const detail = new URLSearchParams(window.location.search).get('detail');

createRoot(document.getElementById('root')!).render(
  <StrictMode>{detail ? <DetailWindow id={detail} /> : <App />}</StrictMode>,
);
