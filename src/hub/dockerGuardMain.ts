import { createServer, request as sendRequest } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { isAllowedDockerRequest } from './docker/dockerGuard.ts';
import type { DockerGuardRequest, DockerGuardRules } from './docker/dockerGuard.ts';

const MAX_BODY_BYTES = 1024 * 1024;
const upstream = new URL(process.env.DOCKER_GUARD_UPSTREAM ?? 'http://docker-proxy:2375');
const port = Number(process.env.DOCKER_GUARD_PORT ?? '2375');
const rules: DockerGuardRules = {
    image: process.env.CLOUDBOT_INSTANCE_IMAGE ?? 'cloudbot:local',
    hubContainer: process.env.HUB_CONTAINER_ID ?? 'cloudbot-hub-1',
};

function refuse(response: ServerResponse, status: number, message: string): void {
    const body = JSON.stringify({ message });

    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
}

function readBody(incoming: IncomingMessage): Promise<Buffer | undefined> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;

            if (size > MAX_BODY_BYTES) {
                resolve(undefined);
                incoming.destroy();

                return;
            }

            chunks.push(chunk);
        });
        incoming.on('end', () => {
            const body = Buffer.concat(chunks);

            resolve(body);
        });
        incoming.on('error', reject);
    });
}

function parseBody(body: Buffer): unknown {
    if (body.length === 0) {
        return undefined;
    }

    try {
        const text = body.toString('utf8');

        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

// Sends the checked path, not the raw one, so Docker gets exactly what the guard looked at.
function forward(request: DockerGuardRequest, response: ServerResponse, body: Buffer): void {
    const headers: Record<string, string> = body.length === 0 ? {} : { 'content-type': 'application/json' };
    const query = request.query.toString();
    const path = query === '' ? request.path : `${request.path}?${query}`;
    const outgoing = sendRequest({ host: upstream.hostname, port: upstream.port, method: request.method, path, headers }, (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
    });

    outgoing.on('error', () => {
        refuse(response, 502, 'Docker is not reachable.');
    });
    outgoing.end(body);
}

async function handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(incoming);

    if (body === undefined) {
        refuse(response, 413, 'Request body too large.');

        return;
    }

    const url = new URL(incoming.url ?? '/', 'http://guard');
    const guardRequest: DockerGuardRequest = {
        method: incoming.method ?? '',
        path: url.pathname,
        query: url.searchParams,
        body: parseBody(body),
    };

    if (!isAllowedDockerRequest(guardRequest, rules)) {
        console.warn(`Docker guard refused ${guardRequest.method} ${guardRequest.path}`);
        refuse(response, 403, 'Refused by the CloudBot Docker guard.');

        return;
    }

    forward(guardRequest, response, body);
}

const server = createServer((incoming, response) => {
    handle(incoming, response)
        .catch(() => {
            refuse(response, 500, 'Docker guard error.');
        });
});

server.listen(port, () => {
    console.log(`Docker guard listening on ${String(port)}, forwarding to ${upstream.origin}`);
});
