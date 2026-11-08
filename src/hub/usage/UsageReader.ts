import { statfs } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';

import type { HostUsage, InstanceUsage } from '../../shared/usageTypes.ts';
import type { InstanceManager, PersonRecord } from '../contract.ts';
import type { DockerApiClient } from '../docker/DockerApi.ts';
import { containerName } from '../instances/DockerInstanceManager.ts';

interface UsageReaderOptions {
    instances: Pick<InstanceManager, 'status'>;
    docker: Pick<DockerApiClient, 'containerStats'>;
    // The CPU limit of one instance, in cores. It is not in the stats, and the hub set it when it made the container.
    instanceCpus: number;
}

const PERCENT_PER_CORE = 100;
// The root of the hub container is on the disk of the server, next to the Docker data.
const DISK_PATH = '/';

// Reads the numbers behind the usage screen. The hub calls it only after it checked who asks.
class UsageReader {
    private readonly instances: UsageReaderOptions['instances'];
    private readonly docker: UsageReaderOptions['docker'];
    private readonly instanceCpus: number;

    constructor(options: UsageReaderOptions) {
        this.instances = options.instances;
        this.docker = options.docker;
        this.instanceCpus = options.instanceCpus;
    }

    async readHost(): Promise<HostUsage> {
        const disk = await statfs(DISK_PATH);
        const memoryTotalBytes = totalmem();
        const [loadAverage = 0] = loadavg();

        return {
            cpuCount: availableParallelism(),
            loadAverage,
            memoryTotalBytes,
            memoryUsedBytes: memoryTotalBytes - freemem(),
            diskTotalBytes: disk.blocks * disk.bsize,
            diskUsedBytes: (disk.blocks - disk.bfree) * disk.bsize,
        };
    }

    // A container that does not run has no numbers. A hibernated instance is such a container.
    async readInstance(record: Pick<PersonRecord, 'name' | 'role'>): Promise<InstanceUsage> {
        const instance = await this.instances.status(record.name);
        const usage: InstanceUsage = { name: record.name, role: record.role, instance, numbers: null };

        if (instance !== 'running' && instance !== 'starting') {
            return usage;
        }

        const instanceContainerName = containerName(record.name);
        const stats = await this.docker.containerStats(instanceContainerName);

        if (stats === undefined) {
            return usage;
        }

        return {
            ...usage,
            numbers: {
                cpuPercent: stats.cpuPercent,
                cpuLimitPercent: this.instanceCpus * PERCENT_PER_CORE,
                memoryBytes: stats.memoryBytes,
                memoryLimitBytes: stats.memoryLimitBytes,
            },
        };
    }
}

export { UsageReader };
export type { UsageReaderOptions };
