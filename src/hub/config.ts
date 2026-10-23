import { checkPersonName } from '../shared/peopleTypes.ts';

interface HubSettings {
    domain: string;
    port: number;
    host: string;
    dataDir: string;
    dockerApiUrl: string;
    instanceImage: string;
    instanceMemoryMb: number;
    instanceBudgetMb: number;
    instanceCpus: number;
    ownerName: string;
    containerId: string;
}

function readRequiredText(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
    const value = env[key] ?? fallback;

    if (value === undefined || value.trim() === '') {
        throw new Error(`${key} is required.`);
    }

    return value.trim();
}

function readPositiveNumber(env: NodeJS.ProcessEnv, key: string, fallback: number, integerOnly = false): number {
    const rawValue = env[key];
    const value = rawValue === undefined || rawValue.trim() === '' ? fallback : Number(rawValue);
    const isValid = Number.isFinite(value) && value > 0 && (!integerOnly || Number.isInteger(value));

    if (!isValid) {
        const kind = integerOnly ? 'positive integer' : 'positive number';

        throw new Error(`${key} must be a ${kind}.`);
    }

    return value;
}

function readDomain(env: NodeJS.ProcessEnv): string {
    const domain = readRequiredText(env, 'CLOUDBOT_DOMAIN');
    const domainLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
    const isValid = domain === 'localhost' || (domain.length <= 253 && domain.split('.')
        .every(label => domainLabelPattern.test(label)));

    if (!isValid) {
        throw new Error('CLOUDBOT_DOMAIN must be a hostname or localhost.');
    }

    return domain.toLowerCase();
}

function readHubSettings(env: NodeJS.ProcessEnv): HubSettings {
    const domain = readDomain(env);
    const ownerName = readRequiredText(env, 'CLOUDBOT_OWNER_NAME', 'owner');
    const invalidOwnerName = checkPersonName(ownerName);

    if (invalidOwnerName !== undefined) {
        throw new Error(`CLOUDBOT_OWNER_NAME is invalid: ${invalidOwnerName}`);
    }

    const containerId = readRequiredText(env, 'HUB_CONTAINER_ID', env.HOSTNAME);
    const settings: HubSettings = {
        domain,
        port: readPositiveNumber(env, 'HUB_PORT', 3001, true),
        host: readRequiredText(env, 'HUB_HOST', '0.0.0.0'),
        dataDir: readRequiredText(env, 'HUB_DATA_DIR', '/var/lib/cloudbot-hub'),
        dockerApiUrl: readRequiredText(env, 'DOCKER_API_URL', 'http://docker-proxy:2375'),
        instanceImage: readRequiredText(env, 'CLOUDBOT_INSTANCE_IMAGE', 'cloudbot:local'),
        instanceMemoryMb: readPositiveNumber(env, 'CLOUDBOT_INSTANCE_MEMORY_MB', 2560, true),
        instanceBudgetMb: readPositiveNumber(env, 'CLOUDBOT_INSTANCE_BUDGET_MB', 10240, true),
        instanceCpus: readPositiveNumber(env, 'CLOUDBOT_INSTANCE_CPUS', 1.5),
        ownerName,
        containerId,
    };

    if (settings.port > 65535) {
        throw new Error('HUB_PORT must be between 1 and 65535.');
    }

    let dockerApiUrl: URL;

    try {
        dockerApiUrl = new URL(settings.dockerApiUrl);
    } catch {
        throw new Error('DOCKER_API_URL must be a valid URL.');
    }

    if (dockerApiUrl.protocol !== 'http:' && dockerApiUrl.protocol !== 'https:') {
        throw new Error('DOCKER_API_URL must use HTTP or HTTPS.');
    }

    return settings;
}

export { readHubSettings };
export type { HubSettings };
