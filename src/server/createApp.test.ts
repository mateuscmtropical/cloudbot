import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from './createApp.ts';

const createdDirectories: string[] = [];

async function createWebRoot(): Promise<string> {
    const webRoot = await mkdtemp(join(tmpdir(), 'cloudbot-web-'));
    const assetsDirectory = join(webRoot, 'assets');

    createdDirectories.push(webRoot);
    await mkdir(assetsDirectory);
    await writeFile(join(webRoot, 'index.html'), '<div id="root"></div>');
    await writeFile(join(assetsDirectory, 'app.js'), 'console.log(1);');

    return webRoot;
}

describe('createApp', () => {
    afterEach(async () => {
        const directories = createdDirectories.splice(0);

        await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
    });

    it('answers the health route with the version', async () => {
        const app = createApp({ version: '1.2.3' });
        const response = await app.request('/api/health');

        expect(response.status)
            .toBe(200);
        expect(await response.json())
            .toEqual({ status: 'ok', version: '1.2.3' });
    });

    it('answers unknown routes with 404', async () => {
        const app = createApp({ version: '1.2.3' });
        const response = await app.request('/api/missing');

        expect(response.status)
            .toBe(404);
    });

    it('keeps the health route working when the web app is built', async () => {
        const webRoot = await createWebRoot();
        const app = createApp({ version: '1.2.3', webRoot });
        const response = await app.request('/api/health');

        expect(await response.json())
            .toEqual({ status: 'ok', version: '1.2.3' });
    });

    it('serves built assets and falls back to index.html for app routes', async () => {
        const webRoot = await createWebRoot();
        const app = createApp({ version: '1.2.3', webRoot });
        const assetResponse = await app.request('/assets/app.js');
        const routeResponse = await app.request('/chats/42');

        expect(await assetResponse.text())
            .toBe('console.log(1);');
        expect(await routeResponse.text())
            .toContain('<div id="root"></div>');
    });

    it('does not answer unknown api routes with index.html', async () => {
        const webRoot = await createWebRoot();
        const app = createApp({ version: '1.2.3', webRoot });
        const response = await app.request('/api/missing');

        expect(response.status)
            .toBe(404);
    });

    it('does not serve the web app when no build exists', async () => {
        const app = createApp({ version: '1.2.3', webRoot: join(tmpdir(), 'cloudbot-missing-web-build') });
        const response = await app.request('/chats/42');

        expect(response.status)
            .toBe(404);
    });
});
