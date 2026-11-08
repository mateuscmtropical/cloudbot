import { describe, expect, it, vi } from 'vitest';

import type { InstanceStatus } from '../../shared/peopleTypes.ts';
import type { DockerContainerStats } from '../docker/DockerApi.ts';
import { UsageReader } from './UsageReader.ts';

const STATS: DockerContainerStats = { cpuPercent: 60, memoryBytes: 1000, memoryLimitBytes: 2000 };

function makeReader(status: InstanceStatus, stats: DockerContainerStats | null = STATS): { reader: UsageReader; containerStats: ReturnType<typeof vi.fn> } {
    const containerStats = vi.fn(() => Promise.resolve(stats ?? undefined));
    const reader = new UsageReader({
        instances: { status: () => Promise.resolve(status) },
        docker: { containerStats },
        instanceCpus: 1.5,
    });

    return { reader, containerStats };
}

describe('UsageReader', () => {
    it('gives the numbers of a running container against its limits', async () => {
        const { reader, containerStats } = makeReader('running');

        const usage = await reader.readInstance({ name: 'maria', role: 'member' });

        expect(usage)
            .toEqual({ name: 'maria', role: 'member', instance: 'running', numbers: { cpuPercent: 60, cpuLimitPercent: 150, memoryBytes: 1000, memoryLimitBytes: 2000 } });
        expect(containerStats)
            .toHaveBeenCalledWith('cloudbot-i-maria');
    });

    it('asks Docker for nothing when the container is hibernated or missing', async () => {
        const stopped = makeReader('stopped');
        const missing = makeReader('missing');

        await expect(stopped.reader.readInstance({ name: 'maria', role: 'member' }))
            .resolves.toEqual({ name: 'maria', role: 'member', instance: 'stopped', numbers: null });
        await expect(missing.reader.readInstance({ name: 'maria', role: 'member' }))
            .resolves.toMatchObject({ instance: 'missing', numbers: null });
        expect(stopped.containerStats)
            .not.toHaveBeenCalled();
        expect(missing.containerStats)
            .not.toHaveBeenCalled();
    });

    it('gives no numbers when the container vanished between the status and the stats', async () => {
        const { reader } = makeReader('running', null);

        await expect(reader.readInstance({ name: 'maria', role: 'member' }))
            .resolves.toMatchObject({ instance: 'running', numbers: null });
    });

    it('reads the numbers of the machine', async () => {
        const { reader } = makeReader('running');

        const host = await reader.readHost();

        expect(host.cpuCount)
            .toBeGreaterThan(0);
        expect(host.memoryTotalBytes)
            .toBeGreaterThan(host.memoryUsedBytes);
        expect(host.diskTotalBytes)
            .toBeGreaterThanOrEqual(host.diskUsedBytes);
        expect(host.diskTotalBytes)
            .toBeGreaterThan(0);
    });
});
