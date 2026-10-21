const DEFAULT_PORT = 3000;

// The cookie is Secure, so the browser keeps it only on localhost or over HTTPS.
// CLOUDBOT_PUBLIC_URL lets the link point at the HTTPS address of the server.
function readServerPort(environment: NodeJS.ProcessEnv): number {
    const parsedPort = Number.parseInt(environment.PORT ?? '', 10);

    return Number.isNaN(parsedPort) ? DEFAULT_PORT : parsedPort;
}

// The address the owner reaches the server at, without a trailing slash.
function readPublicBaseUrl(environment: NodeJS.ProcessEnv): string {
    const configuredBase = environment.CLOUDBOT_PUBLIC_URL ?? '';
    const serverPort = readServerPort(environment);

    return configuredBase === ''
        ? `http://localhost:${String(serverPort)}`
        : configuredBase.replace(/\/+$/, '');
}

function buildSetupLink(setupCode: string, environment: NodeJS.ProcessEnv): string {
    return `${readPublicBaseUrl(environment)}/setup?code=${setupCode}`;
}

export { buildSetupLink, readPublicBaseUrl, readServerPort };
