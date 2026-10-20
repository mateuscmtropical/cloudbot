import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The web app lives in src/web. The server serves the build from dist/web.
export default defineConfig({
    root: 'src/web',
    plugins: [react()],
    build: {
        outDir: '../../dist/web',
        emptyOutDir: true,
    },
});
