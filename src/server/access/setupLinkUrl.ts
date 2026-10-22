const DEFAULT_PORT = 3000;
// Local runs listen on this machine only. The Docker image sets HOST to 0.0.0.0 so Caddy can reach the server.
const DEFAULT_HOST = '127.0.0.1';

// The cookie is Secure, so the browser keeps it only on localhost or over HTTPS.
// CLOUDBOT_PUBLIC_URL lets the link point at the HTTPS address of the server.
function readServerPort(environment: NodeJS.ProcessEnv): number {
    const parsedPort = Number.parseInt(environment.PORT ?? '', 10);

    return Number.isNaN(parsedPort) ? DEFAULT_PORT : parsedPort;
}

// The interface the server listens on. An empty HOST keeps the default.
function readServerHost(environment: NodeJS.ProcessEnv): string {
    const configuredHost = (environment.HOST ?? '').trim();

    return configuredHost === '' ? DEFAULT_HOST : configuredHost;
}

// The name a browser can open for the interface the server listens on. A wildcard address cannot be opened.
function readLocalName(environment: NodeJS.ProcessEnv): string {
    const serverHost = readServerHost(environment);

    if (serverHost === '0.0.0.0' || serverHost === '::' || serverHost === '[::]') {
        return 'localhost';
    }

    return serverHost.includes(':') && !serverHost.startsWith('[') ? `[${serverHost}]` : serverHost;
}

// The address the owner reaches the server at, without a trailing slash.
function readPublicBaseUrl(environment: NodeJS.ProcessEnv): string {
    const configuredBase = environment.CLOUDBOT_PUBLIC_URL ?? '';
    const serverPort = readServerPort(environment);

    return configuredBase === ''
        ? `http://${readLocalName(environment)}:${String(serverPort)}`
        : configuredBase.replace(/\/+$/, '');
}

function buildSetupLink(setupCode: string, environment: NodeJS.ProcessEnv): string {
    return `${readPublicBaseUrl(environment)}/setup?code=${setupCode}`;
}

export { buildSetupLink, readPublicBaseUrl, readServerHost, readServerPort };
