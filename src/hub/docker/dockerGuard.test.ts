import { describe, expect, it } from 'vitest';

import { DockerApi } from './DockerApi.ts';
import { isAllowedDockerRequest } from './dockerGuard.ts';
import type { DockerGuardRequest, DockerGuardRules } from './dockerGuard.ts';

const RULES: DockerGuardRules = { image: 'cloudbot:local', hubContainer: 'cloudbot-hub-1' };

function guardRequest(method: string, target: string, body?: unknown): DockerGuardRequest {
    const url = new URL(target, 'http://guard');

    return { method, path: url.pathname, query: url.searchParams, body };
}

function createBody(): Record<string, unknown> {
    return {
        Image: 'cloudbot:local',
        Env: ['CLOUDBOT_PERSON_NAME=maria'],
        HostConfig: {
            Memory: 1024,
            MemorySwap: 1024,
            NanoCpus: 1000,
            RestartPolicy: { Name: 'no' },
            Privileged: false,
            Mounts: [{ Type: 'volume', Source: 'cbi-maria-data', Target: '/var/lib/cloudbot' }],
            PidsLimit: 4096,
            LogConfig: { Type: 'json-file', Config: { 'max-size': '10m' } },
        },
        NetworkingConfig: { EndpointsConfig: { 'cloudbot-net-maria': { Aliases: ['cloudbot-i-maria'] } } },
    };
}

function isAllowedCreate(changes: Record<string, unknown>, hostChanges: Record<string, unknown> = {}): boolean {
    const body = createBody();
    const hostConfig = { ...(body.HostConfig as Record<string, unknown>), ...hostChanges };
    const request = guardRequest('POST', '/containers/create?name=cloudbot-i-maria', { ...body, HostConfig: hostConfig, ...changes });

    return isAllowedDockerRequest(request, RULES);
}

describe('isAllowedDockerRequest', () => {
    it('lets through every request DockerApi makes', async () => {
        const seen: DockerGuardRequest[] = [];
        const fetchStub: typeof fetch = (input, init) => {
            const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
            const target = input instanceof URL ? input.href : input as string;
            const request = guardRequest(init?.method ?? 'GET', target, body);

            seen.push(request);

            return Promise.resolve(Response.json({ State: { Running: true, Status: 'running' } }));
        };
        const docker = new DockerApi('http://guard', fetchStub);
        const mounts = [{ source: 'cbi-maria-data', target: '/var/lib/cloudbot' }];

        await docker.createNetwork('cloudbot-net-maria');
        await docker.connectContainerToNetwork('cloudbot-net-maria', 'cloudbot-hub-1', ['hub']);
        await docker.createVolume('cbi-maria-data');
        await docker.createContainer('cloudbot-i-maria', { image: 'cloudbot:local', environment: ['A=1'], memoryBytes: 1024, nanoCpus: 1000, mounts, networkName: 'cloudbot-net-maria', containerAlias: 'cloudbot-i-maria' });
        await docker.inspectContainer('cloudbot-i-maria');
        await docker.startContainer('cloudbot-i-maria');
        await docker.stopContainer('cloudbot-i-maria');
        await docker.removeContainer('cloudbot-i-maria');
        await docker.removeVolume('cbi-maria-data');
        await docker.disconnectContainerFromNetwork('cloudbot-net-maria', 'cloudbot-hub-1');
        await docker.removeNetwork('cloudbot-net-maria');

        seen.push(guardRequest('GET', '/_ping'));

        const results = seen.map(request => isAllowedDockerRequest(request, RULES));

        expect(results)
            .toHaveLength(12);
        expect(results.every(Boolean))
            .toBe(true);
    });

    it('refuses any other endpoint or name', () => {
        const refused = [
            guardRequest('GET', '/containers/json'),
            guardRequest('GET', '/images/json'),
            guardRequest('GET', '/info'),
            guardRequest('POST', '/exec/x/start'),
            guardRequest('POST', '/containers/cloudbot-i-maria/exec'),
            guardRequest('GET', '/containers/cloudbot-hub-1/json'),
            guardRequest('DELETE', '/containers/cloudbot-caddy-1'),
            guardRequest('POST', '/containers/cloudbot-i-maria/../cloudbot-hub-1/stop'),
            guardRequest('DELETE', '/volumes/hub-data'),
            guardRequest('POST', '/volumes/create', { Name: 'hub-data' }),
            guardRequest('POST', '/networks/create', { Name: 'cloudbot-net-x', Driver: 'host' }),
            guardRequest('POST', '/networks/cloudbot-net-maria/connect', { Container: 'cloudbot-caddy-1', EndpointConfig: { Aliases: ['hub'] } }),
            guardRequest('POST', '/networks/cloudbot-net-maria/connect', { Container: 'cloudbot-hub-1', EndpointConfig: { Aliases: ['cloudbot-i-other'] } }),
            guardRequest('POST', '/networks/cloudbot-net-maria/disconnect', { Container: 'cloudbot-i-other', Force: true }),
        ];
        const results = refused.map(request => isAllowedDockerRequest(request, RULES));

        expect(results.some(Boolean))
            .toBe(false);
    });

    it('creates only an unprivileged container of the CloudBot image with its own volumes', () => {
        const otherName = guardRequest('POST', '/containers/create?name=evil', createBody());

        expect(isAllowedCreate({}))
            .toBe(true);
        expect(isAllowedDockerRequest(otherName, RULES))
            .toBe(false);
        expect([
            isAllowedCreate({ Image: 'alpine' }),
            isAllowedCreate({ Cmd: ['sh'] }),
            isAllowedCreate({}, { Privileged: true }),
            isAllowedCreate({}, { Binds: ['/:/host'] }),
            isAllowedCreate({}, { CapAdd: ['SYS_ADMIN'] }),
            isAllowedCreate({}, { NetworkMode: 'host' }),
            isAllowedCreate({}, { Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] }),
            isAllowedCreate({}, { Mounts: [{ Type: 'volume', Source: 'hub-data', Target: '/data' }] }),
            isAllowedCreate({ NetworkingConfig: { EndpointsConfig: { hubctl: { Aliases: ['cloudbot-i-maria'] } } } }),
        ])
            .toEqual([false, false, false, false, false, false, false, false, false]);
    });
});
