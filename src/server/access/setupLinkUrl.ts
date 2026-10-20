const DEFAULT_PORT = 3000;

// The cookie is Secure, so the browser keeps it only on localhost or over HTTPS.
// CLOUDBOT_PUBLIC_URL lets the link point at the HTTPS address of the server.
function readServerPort(environment: NodeJS.ProcessEnv): number {
    const parsedPort = Number.parseInt(environment.PORT ?? '', 10);

    return Number.isNaN(parsedPort) ? DEFAULT_PORT : parsedPort;
}

function buildSetupLink(setupCode: string, environment: NodeJS.ProcessEnv): string {
    const configuredBase = environment.CLOUDBOT_PUBLIC_URL ?? '';
    const serverPort = readServerPort(environment);
    const baseUrl = configuredBase === ''
        ? `http://localhost:${String(serverPort)}`
        : configuredBase.replace(/\/+$/, '');

    return `${baseUrl}/setup?code=${setupCode}`;
}

export { buildSetupLink, readServerPort };
