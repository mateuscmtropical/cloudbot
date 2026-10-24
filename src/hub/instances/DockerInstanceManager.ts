import { checkPersonName } from '../../shared/peopleTypes.ts';
import type { InstanceStatus } from '../../shared/peopleTypes.ts';
import type { InstanceManager, PersonRecord, PeopleStore, StartResult } from '../contract.ts';
import type { DockerApiClient, DockerContainerInspection, DockerContainerOptions } from '../docker/DockerApi.ts';
import type { HubSettings } from '../config.ts';

interface DockerInstanceManagerOptions {
    docker: DockerApiClient;
    people: PeopleStore;
    settings: HubSettings;
}

interface NamedInstanceStatus {
    name: string;
    status: InstanceStatus;
}

const INSTANCE_PREFIX = 'cloudbot-i-';
const NETWORK_PREFIX = 'cloudbot-net-';
const VOLUME_PREFIX = 'cbi-';
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 1_000;
const BYTES_PER_MB = 1024 * 1024;
const NANO_CPUS_PER_CPU = 1_000_000_000;
const VOLUME_TARGETS = [
    { suffix: 'data', target: '/var/lib/cloudbot' },
    { suffix: 'home', target: '/home/bot' },
    { suffix: 'workspaces', target: '/var/lib/cloudbot-workspaces' },
    { suffix: 'uploads', target: '/var/lib/cloudbot-uploads' },
] as const;

function assertValidName(name: string): void {
    const nameError = checkPersonName(name);

    if (nameError !== undefined) {
        throw new Error(`Invalid person name: ${nameError}`);
    }
}

function containerName(name: string): string {
    return `${INSTANCE_PREFIX}${name}`;
}

function networkName(name: string): string {
    return `${NETWORK_PREFIX}${name}`;
}

function volumeNames(name: string): string[] {
    return VOLUME_TARGETS.map(volume => `${VOLUME_PREFIX}${name}-${volume.suffix}`);
}

function publicUrl(name: string, settings: HubSettings): string {
    if (settings.domain === 'localhost') {
        return `http://${name}.localhost`;
    }

    return `https://${name}.${settings.domain}`;
}

function toContainerOptions(record: PersonRecord, settings: HubSettings): DockerContainerOptions {
    const instanceName = containerName(record.name);
    const mounts = VOLUME_TARGETS.map(volume => ({
        source: `${VOLUME_PREFIX}${record.name}-${volume.suffix}`,
        target: volume.target,
    }));
    const environment = [
        `CLOUDBOT_HUB_SECRET=${record.instanceSecret}`,
        'CLOUDBOT_HUB_URL=http://hub:3001',
        `CLOUDBOT_PERSON_NAME=${record.name}`,
        `CLOUDBOT_PERSON_ROLE=${record.role}`,
        `CLOUDBOT_PUBLIC_URL=${publicUrl(record.name, settings)}`,
    ];

    return {
        image: settings.instanceImage,
        environment,
        memoryBytes: settings.instanceMemoryMb * BYTES_PER_MB,
        nanoCpus: Math.round(settings.instanceCpus * NANO_CPUS_PER_CPU),
        mounts,
        networkName: networkName(record.name),
        containerAlias: instanceName,
    };
}

function isActiveStatus(status: InstanceStatus): boolean {
    return status === 'running' || status === 'starting';
}

class DockerInstanceManager implements InstanceManager {
    private readonly docker: DockerApiClient;
    private readonly people: PeopleStore;
    private readonly settings: HubSettings;
    private readonly startPromises: Map<string, Promise<StartResult>> = new Map();
    private startQueue: Promise<void> = Promise.resolve();

    constructor(options: DockerInstanceManagerOptions) {
        this.docker = options.docker;
        this.people = options.people;
        this.settings = options.settings;
    }

    async status(name: string): Promise<InstanceStatus> {
        assertValidName(name);
        const instanceContainerName = containerName(name);
        const inspection = await this.docker.inspectContainer(instanceContainerName);

        return this.statusFromInspection(inspection);
    }

    async create(record: PersonRecord): Promise<void> {
        assertValidName(record.name);
        const personContainerName = containerName(record.name);
        const personNetworkName = networkName(record.name);
        const personVolumeNames = volumeNames(record.name);
        const createContainerOptions = toContainerOptions(record, this.settings);
        const createdVolumeNames: string[] = [];
        let networkCreated = false;
        let containerCreated = false;

        try {
            await this.docker.createNetwork(personNetworkName);
            networkCreated = true;

            const dataVolumeName = personVolumeNames[0];
            const homeVolumeName = personVolumeNames[1];
            const workspaceVolumeName = personVolumeNames[2];
            const uploadsVolumeName = personVolumeNames[3];

            if (dataVolumeName === undefined || homeVolumeName === undefined || workspaceVolumeName === undefined || uploadsVolumeName === undefined) {
                throw new Error('The instance volume configuration is incomplete.');
            }

            await this.docker.createVolume(dataVolumeName);
            createdVolumeNames.push(dataVolumeName);
            await this.docker.createVolume(homeVolumeName);
            createdVolumeNames.push(homeVolumeName);
            await this.docker.createVolume(workspaceVolumeName);
            createdVolumeNames.push(workspaceVolumeName);
            await this.docker.createVolume(uploadsVolumeName);
            createdVolumeNames.push(uploadsVolumeName);
            await this.docker.connectContainerToNetwork(personNetworkName, this.settings.containerId, ['hub']);
            await this.docker.createContainer(personContainerName, createContainerOptions);
            containerCreated = true;
        } catch (error: unknown) {
            // The network can go only after the container and the hub have left it.
            const containerCleanupRequests = containerCreated ? [this.docker.removeContainer(personContainerName)] : [];
            const containerCleanupResults = await Promise.allSettled(containerCleanupRequests);
            const networkCleanupRequests = networkCreated ? [this.removeNetworkOfPerson(personNetworkName)] : [];
            const networkCleanupResults = await Promise.allSettled(networkCleanupRequests);
            const volumeCleanupRequests = createdVolumeNames.map(volumeName => this.docker.removeVolume(volumeName));
            const volumeCleanupResults = await Promise.allSettled(volumeCleanupRequests);
            const cleanupResults = [...containerCleanupResults, ...networkCleanupResults, ...volumeCleanupResults];
            const cleanupFailed = cleanupResults.some(result => result.status === 'rejected');

            if (cleanupFailed) {
                throw new Error('Instance creation failed and resource cleanup was incomplete.', { cause: error });
            }

            throw new Error('Could not create the instance resources.', { cause: error });
        }
    }

    start(name: string): Promise<StartResult> {
        assertValidName(name);
        const existingStart = this.startPromises.get(name);

        if (existingStart !== undefined) {
            return existingStart;
        }

        const startPromise = this.startValidated(name)
            .finally(() => this.startPromises.delete(name));

        this.startPromises.set(name, startPromise);

        return startPromise;
    }

    async stop(name: string): Promise<void> {
        assertValidName(name);
        const instanceContainerName = containerName(name);
        const inspection = await this.docker.inspectContainer(instanceContainerName);

        if (inspection?.isRunning !== true) {
            return;
        }

        await this.docker.stopContainer(instanceContainerName);
    }

    async remove(name: string): Promise<void> {
        assertValidName(name);
        const instanceContainerName = containerName(name);
        const instanceNetworkName = networkName(name);
        const instanceVolumeNames = volumeNames(name);

        await this.docker.removeContainer(instanceContainerName);
        await this.removeNetworkOfPerson(instanceNetworkName);

        const volumeRemovalRequests = instanceVolumeNames.map(volumeName => this.docker.removeVolume(volumeName));

        await Promise.all(volumeRemovalRequests);
    }

    // A hub container that was recreated is on none of the networks of the people, so it joins them again.
    // Returns the people whose network it could not join.
    async reconnectHub(): Promise<string[]> {
        const names = this.people.list()
            .map(record => record.name)
            .filter(personName => checkPersonName(personName) === undefined);
        const requests = names.map((personName) => {
            const personNetworkName = networkName(personName);

            return this.docker.connectContainerToNetwork(personNetworkName, this.settings.containerId, ['hub']);
        });
        const results = await Promise.allSettled(requests);

        return names.filter((_personName, index) => results[index]?.status === 'rejected');
    }

    // The hub is on the network of each person, so it leaves before the network is removed.
    private async removeNetworkOfPerson(personNetworkName: string): Promise<void> {
        await this.docker.disconnectContainerFromNetwork(personNetworkName, this.settings.containerId);
        await this.docker.removeNetwork(personNetworkName);
    }

    // The container was removed, for example to move the person to a new image. The network and the volumes are still
    // there, so only the container is created again.
    private async recreateContainer(name: string): Promise<void> {
        const record = this.people.find(name);

        if (record === undefined) {
            throw new Error(`Instance ${name} does not exist.`);
        }

        const personContainerName = containerName(name);
        const createContainerOptions = toContainerOptions(record, this.settings);

        await this.docker.createContainer(personContainerName, createContainerOptions);
    }

    private async startValidated(name: string): Promise<StartResult> {
        const currentStatus = await this.status(name);

        if (currentStatus === 'running') {
            return 'running';
        }

        if (currentStatus === 'missing') {
            await this.recreateContainer(name);
        }

        if (currentStatus === 'starting') {
            await this.waitUntilHealthy(name, Date.now() + HEALTH_TIMEOUT_MS);

            return 'running';
        }

        const wasStarted = await this.startWithinBudget(name);

        if (!wasStarted) {
            return 'busy';
        }
        await this.waitUntilHealthy(name, Date.now() + HEALTH_TIMEOUT_MS);

        return 'running';
    }

    private async startWithinBudget(name: string): Promise<boolean> {
        const startOperation = this.startQueue.then(async () => {
            const fitsMemoryBudget = await this.fitsMemoryBudget(name);

            if (!fitsMemoryBudget) {
                return false;
            }

            const instanceContainerName = containerName(name);

            await this.docker.startContainer(instanceContainerName);

            return true;
        });

        this.startQueue = startOperation.then(() => undefined, () => undefined);

        return startOperation;
    }

    private async fitsMemoryBudget(name: string): Promise<boolean> {
        const people = this.people.list();
        const knownNames = people.map(record => record.name)
            .filter(personName => checkPersonName(personName) === undefined);
        const uniqueNames = new Set([...knownNames, name]);
        const names = Array.from(uniqueNames);
        const statusRequests = names.map(async (personName) => {
            const status = await this.status(personName);

            return { name: personName, status } satisfies NamedInstanceStatus;
        });
        const statuses = await Promise.all(statusRequests);
        const activeNames = statuses.filter(item => isActiveStatus(item.status))
            .map(item => item.name);
        const requestedInstanceCount = activeNames.includes(name) ? 0 : 1;
        const allocatedMemoryMb = (activeNames.length + requestedInstanceCount) * this.settings.instanceMemoryMb;

        return allocatedMemoryMb <= this.settings.instanceBudgetMb;
    }

    private async waitUntilHealthy(name: string, deadline: number): Promise<void> {
        const currentStatus = await this.status(name);

        if (currentStatus === 'running') {
            return;
        }

        if (currentStatus === 'missing' || currentStatus === 'stopped') {
            throw new Error(`Instance ${name} stopped before it became healthy.`);
        }

        if (Date.now() >= deadline) {
            throw new Error(`Instance ${name} did not become healthy within 120 seconds.`);
        }

        const waitForNextCheck = new Promise<void>((resolve) => {
            setTimeout(resolve, HEALTH_POLL_INTERVAL_MS);
        });

        await waitForNextCheck;
        await this.waitUntilHealthy(name, deadline);
    }

    private statusFromInspection(inspection: DockerContainerInspection | undefined): InstanceStatus {
        if (inspection === undefined) {
            return 'missing';
        }

        if (!inspection.isRunning) {
            return 'stopped';
        }

        return inspection.healthStatus === 'healthy' ? 'running' : 'starting';
    }
}

export { DockerInstanceManager };
export type { DockerInstanceManagerOptions };
