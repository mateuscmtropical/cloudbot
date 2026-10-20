import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/server/main.ts'],
    outDir: 'dist/server',
    format: ['esm'],
    target: 'node24',
    platform: 'node',
    clean: true,
    sourcemap: true,
});
