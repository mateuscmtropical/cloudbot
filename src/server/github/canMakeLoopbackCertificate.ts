import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the same openssl command as createLoopbackCertificate, with the key in a private temporary file. Some installs
// print a version but cannot make a certificate, such as a missing config file. The tests use this probe to skip.
function canMakeLoopbackCertificate(): boolean {
    const keyPair = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const temporaryRoot = tmpdir();
    const privateTemplate = join(temporaryRoot, 'cloudbot-github-probe-');
    const privateDirectory = mkdtempSync(privateTemplate);
    const keyFile = join(privateDirectory, 'key.pem');
    const args = ['req', '-x509', '-new', '-key', keyFile, '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1'];

    try {
        writeFileSync(keyFile, keyPair.privateKey, { mode: 0o600 });
        execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'ignore'] });

        return true;
    } catch {
        return false;
    } finally {
        rmSync(privateDirectory, { recursive: true, force: true });
    }
}

export { canMakeLoopbackCertificate };
