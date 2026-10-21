import { readFile, readdir, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { canMakeLoopbackCertificate } from './canMakeLoopbackCertificate.ts';
import { createLoopbackCertificate, removeLoopbackCertificate } from './loopbackCertificate.ts';

const canRunOpenssl = canMakeLoopbackCertificate();

describe.skipIf(!canRunOpenssl)('createLoopbackCertificate', () => {
    it('keeps only public files on disk, and none of them holds the private key', async () => {
        const certificate = await createLoopbackCertificate();

        try {
            const publicCertificate = await readFile(certificate.caFile, 'utf8');
            const bundle = await readFile(certificate.bundleFile, 'utf8');
            const publicFiles = await readdir(certificate.caDirectory);
            const fileStats = await stat(certificate.caFile);

            expect(certificate.key)
                .toContain('PRIVATE KEY');
            expect(certificate.cert)
                .toContain('BEGIN CERTIFICATE');
            expect(publicCertificate)
                .toBe(certificate.cert);
            expect(publicFiles.sort())
                .toEqual(['bundle.pem', 'ca.pem']);
            expect(fileStats.isFile())
                .toBe(true);
            expect(bundle.endsWith(certificate.cert))
                .toBe(true);
            expect(bundle)
                .not.toContain('PRIVATE KEY');
            expect(publicCertificate)
                .not.toContain('PRIVATE KEY');
        } finally {
            await removeLoopbackCertificate(certificate);
        }
    });

    it('removes its public folder', async () => {
        const certificate = await createLoopbackCertificate();

        await removeLoopbackCertificate(certificate);

        await expect(stat(certificate.caFile)).rejects.toThrow();
    });
});
