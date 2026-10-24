import { describe, expect, it } from 'vitest';

import { DockerApi } from './DockerApi.ts';

interface RecordedRequest {
    url: string;
    init: RequestInit;
}

function readFetchUrl(input: unknown): string {
    if (typeof input === 'string') {
        return input;
    }

    if (input instanceof URL) {
        return input.href;
    }

    if (input instanceof Request) {
        return input.url;
    }

    throw new Error('Expected a URL request input.');
}

function readBody(request: RecordedRequest | undefined): string {
    const body = request?.init.body;

    if (typeof body !== 'string') {
        throw new Error('Expected a JSON request body.');
    }

    return body;
}

function parseBody(body: string): unknown {
    const value: unknown = JSON.parse(body) as unknown;

    return value;
}

function createFetch(responseFactory: (request: RecordedRequest) => Response = () => new Response(null, { status: 200 })): { fetchFunction: typeof fetch; requests: RecordedRequest[] } {
    const requests: RecordedRequest[] = [];
    const fetchFunction: typeof fetch = (input, init = {}) => {
        const request: RecordedRequest = { url: readFetchUrl(input), init };

        requests.push(request);

        return Promise.resolve(responseFactory(request));
    };

    return { fetchFunction, requests };
}

describe('DockerApi', () => {
    it('sends internal network and volume requests', async () => {
        const { fetchFunction, requests } = createFetch();
        const docker = new DockerApi('http://docker-proxy:2375', fetchFunction);

        await docker.createNetwork('cloudbot-net-maria');
        await docker.createVolume('cbi-maria-data');
        await docker.connectContainerToNetwork('cloudbot-net-maria', 'hub-id', ['hub']);
        await docker.disconnectContainerFromNetwork('cloudbot-net-maria', 'hub-id');

        expect(requests.map(request => [request.init.method, new URL(request.url).pathname]))
            .toEqual([
                ['POST', '/networks/create'],
                ['POST', '/volumes/create'],
                ['POST', '/networks/cloudbot-net-maria/connect'],
                ['POST', '/networks/cloudbot-net-maria/disconnect'],
            ]);
        const networkBody = parseBody(readBody(requests[0]));
        const connectionBody = parseBody(readBody(requests[2]));
        const disconnectionBody = parseBody(readBody(requests[3]));

        // The network is not internal, so the instance can reach AI providers and the web.
        expect(networkBody)
            .toEqual({ Name: 'cloudbot-net-maria', Driver: 'bridge' });
        expect(connectionBody)
            .toEqual({ Container: 'hub-id', EndpointConfig: { Aliases: ['hub'] } });
        expect(disconnectionBody)
            .toEqual({ Container: 'hub-id', Force: true });
    });

    it('sets container memory, CPU, restart and volume limits without publishing ports', async () => {
        const { fetchFunction, requests } = createFetch();
        const docker = new DockerApi('http://docker-proxy:2375', fetchFunction);

        await docker.createContainer('cloudbot-i-maria', {
            image: 'cloudbot:local',
            environment: ['CLOUDBOT_HUB_SECRET=secret'],
            memoryBytes: 2684354560,
            nanoCpus: 1500000000,
            mounts: [{ source: 'cbi-maria-data', target: '/var/lib/cloudbot' }],
            networkName: 'cloudbot-net-maria',
            containerAlias: 'cloudbot-i-maria',
        });

        const containerBody = parseBody(readBody(requests[0]));

        expect(containerBody)
            .toEqual({
                Image: 'cloudbot:local',
                Env: ['CLOUDBOT_HUB_SECRET=secret'],
                HostConfig: {
                    Memory: 2684354560,
                    MemorySwap: 2684354560,
                    NanoCpus: 1500000000,
                    RestartPolicy: { Name: 'no' },
                    Privileged: false,
                    Mounts: [{ Type: 'volume', Source: 'cbi-maria-data', Target: '/var/lib/cloudbot' }],
                },
                NetworkingConfig: { EndpointsConfig: { 'cloudbot-net-maria': { Aliases: ['cloudbot-i-maria'] } } },
            });
    });

    it('reads container health and treats Docker 404 as missing', async () => {
        const fetchFunction: typeof fetch = (input) => {
            const url = readFetchUrl(input);

            if (url.endsWith('/missing/json')) {
                return Promise.resolve(new Response(null, { status: 404 }));
            }

            const body = JSON.stringify({ State: { Running: true, Status: 'running', Health: { Status: 'healthy' } } });

            return Promise.resolve(new Response(body));
        };
        const docker = new DockerApi('http://docker-proxy:2375', fetchFunction);

        const inspection = await docker.inspectContainer('cloudbot-i-maria');
        const missing = await docker.inspectContainer('missing');

        expect(inspection)
            .toEqual({ isRunning: true, state: 'running', healthStatus: 'healthy' });
        expect(missing)
            .toBeUndefined();
    });

    it('accepts a connection to a network the container is already on', async () => {
        const { fetchFunction } = createFetch(() => new Response(null, { status: 403 }));
        const docker = new DockerApi('http://docker-proxy:2375', fetchFunction);

        await expect(docker.connectContainerToNetwork('cloudbot-net-maria', 'hub-id', ['hub']))
            .resolves.toBeUndefined();
    });

    it('rejects unsuccessful Docker responses with status and endpoint', async () => {
        const { fetchFunction } = createFetch(() => new Response(null, { status: 500 }));
        const docker = new DockerApi('http://docker-proxy:2375', fetchFunction);

        await expect(docker.createNetwork('cloudbot-net-maria'))
            .rejects.toThrow('Docker API POST /networks/create returned 500.');
    });
});
