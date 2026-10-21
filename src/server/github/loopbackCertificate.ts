import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface LoopbackCertificate {
    // The private key. It exists in this process, and only for a moment in a private folder while openssl reads it.
    key: string;
    cert: string;
    // The certificate alone, for git's sslCAInfo on the proxy address.
    caFile: string;
    // The system roots plus the certificate, for SSL_CERT_FILE. Other tools in the shell still trust the usual CAs.
    bundleFile: string;
    // The folder of both public files. It is readable by the bot user and removed when the server stops.
    caDirectory: string;
}

const OPENSSL_TIMEOUT_MS = 30 * 1000;
const CERTIFICATE_DAYS = '3650';
const LOOPBACK_SUBJECT = '/CN=127.0.0.1';
const LOOPBACK_ADDRESS_EXTENSION = 'subjectAltName=IP:127.0.0.1';
const KEY_BITS = 2048;
const SYSTEM_BUNDLE_PATH = '/etc/ssl/certs/ca-certificates.crt';
const PUBLIC_DIRECTORY_MODE = 0o755;
const PUBLIC_FILE_MODE = 0o644;
const PRIVATE_FILE_MODE = 0o600;

// Node gives a child process socket stdin on Linux, and openssl cannot open that through /dev/stdin. So the key is
// written to a file that only this user can read, and that file is removed as soon as openssl has read it.
function opensslArguments(keyFile: string): string[] {
    return ['req', '-x509', '-new', '-key', keyFile, '-subj', LOOPBACK_SUBJECT, '-addext', LOOPBACK_ADDRESS_EXTENSION, '-days', CERTIFICATE_DAYS];
}

// spawn runs openssl without a shell, so no value from the outside reaches a command line.
function runOpenssl(keyFile: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const args = opensslArguments(keyFile);
        const child = spawn('openssl', args, { stdio: ['ignore', 'pipe', 'ignore'] });
        const chunks: Buffer[] = [];
        const timer = setTimeout(() => {
            child.kill();
        }, OPENSSL_TIMEOUT_MS);

        child.stdout.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
        });
        child.on('error', () => {
            clearTimeout(timer);
            reject(new Error('openssl could not make the loopback certificate.'));
        });
        child.on('close', (exitCode) => {
            clearTimeout(timer);

            if (exitCode !== 0) {
                reject(new Error('openssl could not make the loopback certificate.'));

                return;
            }

            const certificate = Buffer.concat(chunks)
                .toString('utf8');

            resolve(certificate);
        });
    });
}

// The key is made in Node and kept as a PEM string, which is what https.createServer takes.
function generateLoopbackKey(): string {
    const keyPair = generateKeyPairSync('rsa', {
        modulusLength: KEY_BITS,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });

    return keyPair.privateKey;
}

// Reads the key file for openssl, then deletes its folder whatever happens.
async function certificateFromKey(key: string): Promise<string> {
    const temporaryRoot = tmpdir();
    const privateTemplate = join(temporaryRoot, 'cloudbot-github-key-');
    const privateDirectory = await mkdtemp(privateTemplate);
    const keyFile = join(privateDirectory, 'key.pem');

    try {
        await writeFile(keyFile, key, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });

        return await runOpenssl(keyFile);
    } finally {
        await rm(privateDirectory, { recursive: true, force: true });
    }
}

// The system bundle is optional. Without it (for example on Windows) the bundle holds only the loopback certificate.
async function readSystemBundle(): Promise<string> {
    return readFile(SYSTEM_BUNDLE_PATH, 'utf8')
        .catch(() => '');
}

function joinPemText(systemBundle: string, certificate: string): string {
    const separatedBundle = systemBundle.length === 0 || systemBundle.endsWith('\n') ? systemBundle : `${systemBundle}\n`;

    return `${separatedBundle}${certificate}`;
}

// Makes a self-signed certificate for 127.0.0.1. The proxy listens only on that address, so no CA is needed.
async function createLoopbackCertificate(): Promise<LoopbackCertificate> {
    const key = generateLoopbackKey();
    const cert = await certificateFromKey(key);
    const temporaryRoot = tmpdir();
    const caTemplate = join(temporaryRoot, 'cloudbot-github-ca-');
    const caDirectory = await mkdtemp(caTemplate);
    const caFile = join(caDirectory, 'ca.pem');
    const bundleFile = join(caDirectory, 'bundle.pem');
    const systemBundle = await readSystemBundle();

    await chmod(caDirectory, PUBLIC_DIRECTORY_MODE);
    await writeFile(caFile, cert, 'utf8');
    await chmod(caFile, PUBLIC_FILE_MODE);
    const bundleText = joinPemText(systemBundle, cert);

    await writeFile(bundleFile, bundleText, 'utf8');
    await chmod(bundleFile, PUBLIC_FILE_MODE);

    return { key, cert, caFile, bundleFile, caDirectory };
}

// Removes the public folder when the server stops. The key was never written there.
async function removeLoopbackCertificate(certificate: LoopbackCertificate): Promise<void> {
    await rm(certificate.caDirectory, { recursive: true, force: true });
}

export { createLoopbackCertificate, removeLoopbackCertificate };
export type { LoopbackCertificate };
