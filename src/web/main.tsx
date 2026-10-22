import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { registerServiceWorker } from './pushClient.ts';
import './styles.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
    throw new Error('Missing #root element in index.html');
}

createRoot(rootElement)
    .render(
        <StrictMode>
            <App />
        </StrictMode>,
    );

// The service worker is what makes the app installable and shows its notifications. The app works without it, so a refusal is ignored.
registerServiceWorker()
    .catch(() => undefined);
