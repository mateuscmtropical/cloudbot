import { request as httpsRequest } from 'node:https';

import { describe, expect, it } from 'vitest';

import { canMakeLoopbackCertificate } from './canMakeLoopbackCertificate.ts';
import { GithubProxy } from './GithubProxy.ts';
import { createLoopbackCertificate, removeLoopbackCertificate } from './loopbackCertificate.ts';

const canRunProxy = canMakeLoopbackCertificate();

// Resolves with the error code of a refused connection, or with 'answered' when the port still listens.
function probePort(port: number, cert: string): Promise<string> {
    return new Promise((resolve) => {
        const probe = httpsRequest({ host: '127.0.0.1', port, path: '/', method: 'GET', ca: cert }, () => {
            resolve('answered');
        });

        probe.on('error', (error: NodeJS.ErrnoException) => {
            resolve(error.code ?? 'error');
        });
        probe.end();
    });
}

describe.skipIf(!canRunProxy)('GithubProxy.forget', () => {
    it('stops the listener of a deleted bot, so its port refuses connections', async () => {
        const certificate = await createLoopbackCertificate();
        const proxy = new GithubProxy({
            readToken: () => undefined,
            approve: () => Promise.resolve(false),
            key: certificate.key,
            cert: certificate.cert,
            caFile: certificate.caFile,
            bundleFile: certificate.bundleFile,
        });

        try {
            const environment = await proxy.environmentFor('bot-1');
            const port = Number((environment.GH_HOST ?? '').split(':')[1]);

            expect(await probePort(port, certificate.cert))
                .toBe('answered');

            await proxy.forget('bot-1');

            expect(await probePort(port, certificate.cert))
                .toBe('ECONNREFUSED');
        } finally {
            await proxy.close();
            await removeLoopbackCertificate(certificate);
        }
    });
});
