import { describe, expect, it } from 'vitest';

import type { PeopleStore, PersonRecord, PersonUpdate } from '../contract.ts';
import type { HubSettings } from '../config.ts';
import type { DockerApiClient, DockerContainerInspection, DockerContainerOptions } from '../docker/DockerApi.ts';
import { DockerInstanceManager } from './DockerInstanceManager.ts';

class FakePeopleStore implements PeopleStore {
    private readonly records: Map<string, PersonRecord>;

    constructor(records: PersonRecord[]) {
        this.records = new Map(records.map(record => [record.name, record]));
    }

    list(): PersonRecord[] {
        return Array.from(this.records.values());
    }

    find(name: string): PersonRecord | undefined {
        return this.records.get(name);
    }

    add(record: PersonRecord): void {
        this.records.set(record.name, record);
    }

    update(name: string, update: PersonUpdate): void {
        const record = this.records.get(name);

        if (record !== undefined) {
            this.records.set(name, { ...record, ...update });
        }
    }

    remove(name: string): void {
        this.records.delete(name);
    }
}

class FakeDockerApi implements DockerApiClient {
    readonly calls: string[] = [];
    readonly inspections: Map<string, DockerContainerInspection> = new Map();
    readonly createdContainers: Map<string, DockerContainerOptions> = new Map();
    readonly missingNetworks: Set<string> = new Set();
    startCalls = 0;

    createNetwork(name: string): Promise<void> {
        this.calls.push(`createNetwork:${name}`);

        return Promise.resolve();
    }

    removeNetwork(name: string): Promise<void> {
        this.calls.push(`removeNetwork:${name}`);

        return Promise.resolve();
    }

    connectContainerToNetwork(networkName: string, containerName: string, aliases: string[]): Promise<void> {
        this.calls.push(`connect:${networkName}:${containerName}:${aliases.join(',')}`);

        if (this.missingNetworks.has(networkName)) {
            return Promise.reject(new Error(`Network ${networkName} does not exist.`));
        }

        return Promise.resolve();
    }

    disconnectContainerFromNetwork(networkName: string, containerName: string): Promise<void> {
        this.calls.push(`disconnect:${networkName}:${containerName}`);

        return Promise.resolve();
    }

    createVolume(name: string): Promise<void> {
        this.calls.push(`createVolume:${name}`);

        return Promise.resolve();
    }

    removeVolume(name: string): Promise<void> {
        this.calls.push(`removeVolume:${name}`);

        return Promise.resolve();
    }

    createContainer(name: string, options: DockerContainerOptions): Promise<void> {
        this.calls.push(`createContainer:${name}`);
        this.createdContainers.set(name, options);
        this.inspections.set(name, { isRunning: false, state: 'created', healthStatus: undefined });

        return Promise.resolve();
    }

    inspectContainer(name: string): Promise<DockerContainerInspection | undefined> {
        this.calls.push(`inspect:${name}`);

        return Promise.resolve(this.inspections.get(name));
    }

    startContainer(name: string): Promise<void> {
        this.calls.push(`start:${name}`);
        this.startCalls += 1;
        this.inspections.set(name, { isRunning: true, state: 'running', healthStatus: 'healthy' });

        return Promise.resolve();
    }

    stopContainer(name: string): Promise<void> {
        this.calls.push(`stop:${name}`);
        this.inspections.set(name, { isRunning: false, state: 'exited', healthStatus: undefined });

        return Promise.resolve();
    }

    removeContainer(name: string): Promise<void> {
        this.calls.push(`removeContainer:${name}`);
        this.inspections.delete(name);

        return Promise.resolve();
    }
}

const SETTINGS: HubSettings = {
    domain: 'example.com',
    port: 3001,
    host: '0.0.0.0',
    dataDir: '/tmp/cloudbot-hub',
    dockerApiUrl: 'http://docker-proxy:2375',
    instanceImage: 'cloudbot:local',
    instanceMemoryMb: 2560,
    instanceBudgetMb: 10240,
    instanceCpus: 1.5,
    ownerName: 'owner',
    containerId: 'hub-id',
};

function makeRecord(name: string, role: PersonRecord['role'] = 'member'): PersonRecord {
    return {
        name,
        role,
        state: 'active',
        passwordHash: 'scrypt$aa$bb',
        mustChangePassword: true,
        instanceSecret: `${name}-secret`,
        createdAt: 1,
        lastSeenAt: null,
    };
}

function makeManager(records: PersonRecord[] = [], settings: HubSettings = SETTINGS): { manager: DockerInstanceManager; docker: FakeDockerApi } {
    const docker = new FakeDockerApi();
    const people = new FakePeopleStore(records);
    const manager = new DockerInstanceManager({ docker, people, settings });

    return { manager, docker };
}

describe('DockerInstanceManager', () => {
    it('creates a person in an isolated network with four named volumes and fixed settings', async () => {
        const { manager, docker } = makeManager();

        await manager.create(makeRecord('maria'));

        const options = docker.createdContainers.get('cloudbot-i-maria');

        expect(docker.calls)
            .toContain('createNetwork:cloudbot-net-maria');
        expect(docker.calls)
            .toContain('connect:cloudbot-net-maria:hub-id:hub');
        expect(options)
            .toMatchObject({
                image: 'cloudbot:local',
                environment: [
                    'CLOUDBOT_HUB_SECRET=maria-secret',
                    'CLOUDBOT_HUB_URL=http://hub:3001',
                    'CLOUDBOT_PERSON_NAME=maria',
                    'CLOUDBOT_PERSON_ROLE=member',
                    'CLOUDBOT_PUBLIC_URL=https://maria.example.com',
                ],
                memoryBytes: 2684354560,
                nanoCpus: 1500000000,
                networkName: 'cloudbot-net-maria',
                containerAlias: 'cloudbot-i-maria',
                mounts: [
                    { source: 'cbi-maria-data', target: '/var/lib/cloudbot' },
                    { source: 'cbi-maria-home', target: '/home/bot' },
                    { source: 'cbi-maria-workspaces', target: '/var/lib/cloudbot-workspaces' },
                    { source: 'cbi-maria-uploads', target: '/var/lib/cloudbot-uploads' },
                ],
            });
    });

    it('gives the Google client to the instance only when the admin set one', async () => {
        const withClient = makeManager([], { ...SETTINGS, googleClient: { clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret-1' } });
        const withoutClient = makeManager();

        await withClient.manager.create(makeRecord('maria'));
        await withoutClient.manager.create(makeRecord('maria'));

        const withEnvironment = withClient.docker.createdContainers.get('cloudbot-i-maria')?.environment ?? [];
        const withoutEnvironment = withoutClient.docker.createdContainers.get('cloudbot-i-maria')?.environment ?? [];

        expect(withEnvironment)
            .toContain('CLOUDBOT_GOOGLE_CLIENT_ID=id.apps.googleusercontent.com');
        expect(withEnvironment)
            .toContain('CLOUDBOT_GOOGLE_CLIENT_SECRET=secret-1');
        expect(withoutEnvironment.some(line => line.includes('GOOGLE')))
            .toBe(false);
    });

    it('maps missing, stopped, starting and healthy containers to their statuses', async () => {
        const { manager, docker } = makeManager();

        docker.inspections.set('cloudbot-i-joao', { isRunning: false, state: 'exited', healthStatus: undefined });
        docker.inspections.set('cloudbot-i-maria', { isRunning: true, state: 'running', healthStatus: 'starting' });
        docker.inspections.set('cloudbot-i-owner', { isRunning: true, state: 'running', healthStatus: 'healthy' });

        const statuses = await Promise.all([
            manager.status('unknown'),
            manager.status('joao'),
            manager.status('maria'),
            manager.status('owner'),
        ]);

        expect(statuses)
            .toEqual(['missing', 'stopped', 'starting', 'running']);
    });

    it('creates the container again when it was removed and then starts it', async () => {
        const { manager, docker } = makeManager([makeRecord('maria')]);

        const result = await manager.start('maria');

        expect(result)
            .toBe('running');
        expect(docker.calls)
            .toContain('createContainer:cloudbot-i-maria');
        expect(docker.calls)
            .not
            .toContain('createNetwork:cloudbot-net-maria');
        expect(docker.startCalls)
            .toBe(1);
    });

    it('joins the network of every person again and reports the ones it could not join', async () => {
        const { manager, docker } = makeManager([makeRecord('maria'), makeRecord('joao')]);

        docker.missingNetworks.add('cloudbot-net-joao');

        const failed = await manager.reconnectHub();

        expect(docker.calls)
            .toContain('connect:cloudbot-net-maria:hub-id:hub');
        expect(failed)
            .toEqual(['joao']);
    });

    it('refuses to start a person who does not exist', async () => {
        const { manager, docker } = makeManager();

        await expect(manager.start('maria'))
            .rejects.toThrow('Instance maria does not exist.');
        expect(docker.startCalls)
            .toBe(0);
    });

    it('shares a concurrent start for the same person', async () => {
        const record = makeRecord('maria');
        const { manager, docker } = makeManager([record]);

        docker.inspections.set('cloudbot-i-maria', { isRunning: false, state: 'exited', healthStatus: undefined });

        const starts = await Promise.all([manager.start('maria'), manager.start('maria')]);

        expect(starts)
            .toEqual(['running', 'running']);
        expect(docker.startCalls)
            .toBe(1);
    });

    it('returns busy when another running instance exhausts the memory budget', async () => {
        const settings: HubSettings = { ...SETTINGS, instanceBudgetMb: 2560 };
        const { manager, docker } = makeManager([makeRecord('owner', 'owner'), makeRecord('maria')], settings);

        docker.inspections.set('cloudbot-i-owner', { isRunning: true, state: 'running', healthStatus: 'healthy' });
        docker.inspections.set('cloudbot-i-maria', { isRunning: false, state: 'exited', healthStatus: undefined });

        const result = await manager.start('maria');

        expect(result)
            .toBe('busy');
        expect(docker.startCalls)
            .toBe(0);
    });

    it('rejects invalid names before calling Docker', async () => {
        const { manager, docker } = makeManager();

        await expect(manager.status('Maria'))
            .rejects.toThrow('Invalid person name:');
        await expect(manager.create(makeRecord('bad name')))
            .rejects.toThrow('Invalid person name:');

        expect(docker.calls)
            .toEqual([]);
    });

    it('stops only running containers and removes all instance resources', async () => {
        const { manager, docker } = makeManager();

        docker.inspections.set('cloudbot-i-maria', { isRunning: true, state: 'running', healthStatus: 'healthy' });

        await manager.stop('maria');
        await manager.remove('maria');

        expect(docker.calls)
            .toContain('stop:cloudbot-i-maria');
        expect(docker.calls)
            .toContain('removeContainer:cloudbot-i-maria');
        expect(docker.calls)
            .toContain('removeNetwork:cloudbot-net-maria');
        expect(docker.calls.filter(call => call.startsWith('removeVolume:')))
            .toHaveLength(4);
    });

    it('removes the container, then lets the hub leave the network, then removes the network', async () => {
        const { manager, docker } = makeManager();

        await manager.remove('maria');

        const containerIndex = docker.calls.indexOf('removeContainer:cloudbot-i-maria');
        const disconnectIndex = docker.calls.findIndex(call => call.startsWith('disconnect:cloudbot-net-maria:'));
        const networkIndex = docker.calls.indexOf('removeNetwork:cloudbot-net-maria');

        expect(containerIndex)
            .toBeGreaterThanOrEqual(0);
        expect(disconnectIndex)
            .toBeGreaterThan(containerIndex);
        expect(networkIndex)
            .toBeGreaterThan(disconnectIndex);
    });

    it('keeps concurrent starts within the shared memory budget', async () => {
        const settings: HubSettings = { ...SETTINGS, instanceBudgetMb: 2560 };
        const records = [makeRecord('maria'), makeRecord('joao')];
        const { manager, docker } = makeManager(records, settings);

        docker.inspections.set('cloudbot-i-maria', { isRunning: false, state: 'exited', healthStatus: undefined });
        docker.inspections.set('cloudbot-i-joao', { isRunning: false, state: 'exited', healthStatus: undefined });

        const results = await Promise.all([manager.start('maria'), manager.start('joao')]);

        expect(results)
            .toEqual(['running', 'busy']);
        expect(docker.startCalls)
            .toBe(1);
    });
});
