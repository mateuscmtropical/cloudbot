import { defineConfig } from 'tsup';
import type { Options } from 'tsup';

const sharedOptions: Options = {
    format: ['esm'],
    target: 'node24',
    platform: 'node',
    // By default tsup strips the node: prefix, which turns node:sqlite into a bare "sqlite" import.
    removeNodeProtocol: false,
    clean: true,
    sourcemap: true,
};

export default defineConfig([
    {
        ...sharedOptions,
        entry: ['src/server/main.ts', 'src/server/newSetupLink.ts'],
        outDir: 'dist/server',
    },
    {
        ...sharedOptions,
        entry: ['src/hub/main.ts'],
        outDir: 'dist/hub',
    },
]);
