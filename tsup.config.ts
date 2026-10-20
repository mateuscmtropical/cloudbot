import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/server/main.ts', 'src/server/newSetupLink.ts'],
    outDir: 'dist/server',
    format: ['esm'],
    target: 'node24',
    platform: 'node',
    // By default tsup strips the node: prefix, which turns node:sqlite into a bare "sqlite" import.
    removeNodeProtocol: false,
    clean: true,
    sourcemap: true,
});
