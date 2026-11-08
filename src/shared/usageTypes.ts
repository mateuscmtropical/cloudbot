import type { InstanceStatus, PersonRole } from './peopleTypes.ts';

// The numbers of the machine, read by the hub from inside its own container. Memory, CPU count and load are the host's,
// because a container sees them unchanged. The disk is the one that holds the hub's files and the Docker data.
interface HostUsage {
    cpuCount: number;
    // The load of the last minute. A load equal to the CPU count means every core is busy.
    loadAverage: number;
    memoryTotalBytes: number;
    memoryUsedBytes: number;
    diskTotalBytes: number;
    diskUsedBytes: number;
}

// What a running container uses now, against its limits. A CPU percent of 100 is one full core.
interface ContainerNumbers {
    cpuPercent: number;
    cpuLimitPercent: number;
    memoryBytes: number;
    memoryLimitBytes: number;
}

// One instance. The numbers are null while the container does not run, for example when it is hibernated.
interface InstanceUsage {
    name: string;
    role: PersonRole;
    instance: InstanceStatus;
    numbers: ContainerNumbers | null;
}

// What the server owner sees: the machine and every instance, shared groups included.
interface ServerUsage {
    host: HostUsage;
    instances: InstanceUsage[];
}

export type { ContainerNumbers, HostUsage, InstanceUsage, ServerUsage };
