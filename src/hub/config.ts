import { BlockList, isIP } from 'node:net';

import { readGoogleClientEnv } from '../shared/googleClientEnv.ts';
import type { GoogleClientEnv } from '../shared/googleClientEnv.ts';
import { readAiMemoryEnabled } from '../shared/aiMemory.ts';
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
    loginAllowedIps?: BlockList;
    // The Google Cloud client the admin set in the install .env. The hub gives it to each instance it starts.
    googleClient?: GoogleClientEnv;
    // How long an instance may be idle before it stops, in ms. Unset means the IdleWatcher default.
    idleMs?: number;
    // The long-term memory switch of the instances. The hub passes it to each instance it starts.
    aiMemory: boolean;
}

interface DockerGuardSettings {
    upstream: URL;
    port: number;
    image: string;
    hubContainer: string;
}

const MINUTE_MS = 60 * 1000;

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

function readLoginAllowedIps(env: NodeJS.ProcessEnv): BlockList | undefined {
    const rawValue = env.CLOUDBOT_LOGIN_ALLOWED_IPS;

    if (rawValue === undefined || rawValue.trim() === '') {
        return undefined;
    }

    const blockList = new BlockList();
    const entries = rawValue.split(',')
        .map(entry => entry.trim());

    entries.forEach((entry) => {
        const [address, prefix, extraPrefixPart] = entry.split('/');
        const addressVersion = isIP(address ?? '');
        const addressType = addressVersion === 4 ? 'ipv4' : 'ipv6';
        const maximumPrefix = addressVersion === 4 ? 32 : 128;
        const prefixValue = prefix === undefined ? undefined : Number(prefix);
        const hasValidPrefix = prefix === undefined
            || (extraPrefixPart === undefined && /^\d+$/.test(prefix) && prefixValue !== undefined && prefixValue <= maximumPrefix);

        if (addressVersion === 0 || !hasValidPrefix) {
            throw new Error(`CLOUDBOT_LOGIN_ALLOWED_IPS has invalid entry "${entry}".`);
        }

        if (prefixValue === undefined) {
            blockList.addAddress(address ?? '', addressType);

            return;
        }

        blockList.addSubnet(address ?? '', prefixValue, addressType);
    });

    return blockList;
}

function readIdleMs(env: NodeJS.ProcessEnv): number | undefined {
    const configuredMinutes = Number(env.CLOUDBOT_IDLE_MINUTES);

    return Number.isFinite(configuredMinutes) && configuredMinutes > 0
        ? configuredMinutes * MINUTE_MS
        : undefined;
}

function readHubSettings(env: NodeJS.ProcessEnv): HubSettings {
    const domain = readDomain(env);
    const ownerName = readRequiredText(env, 'CLOUDBOT_OWNER_NAME', 'owner');
    const invalidOwnerName = checkPersonName(ownerName);

    if (invalidOwnerName !== undefined) {
        throw new Error(`CLOUDBOT_OWNER_NAME is invalid: ${invalidOwnerName}`);
    }

    const containerId = readRequiredText(env, 'HUB_CONTAINER_ID', env.HOSTNAME);
    const loginAllowedIps = readLoginAllowedIps(env);
    const googleClient = readGoogleClientEnv(env);
    const idleMs = readIdleMs(env);
    const settings: HubSettings = {
        domain,
        port: readPositiveNumber(env, 'HUB_PORT', 3001, true),
        host: readRequiredText(env, 'HUB_HOST', '0.0.0.0'),
        dataDir: readRequiredText(env, 'HUB_DATA_DIR', '/var/lib/cloudbot-hub'),
        dockerApiUrl: readRequiredText(env, 'DOCKER_API_URL', 'http://docker-guard:2375'),
        instanceImage: readRequiredText(env, 'CLOUDBOT_INSTANCE_IMAGE', 'cloudbot:local'),
        instanceMemoryMb: readPositiveNumber(env, 'CLOUDBOT_INSTANCE_MEMORY_MB', 2560, true),
        instanceBudgetMb: readPositiveNumber(env, 'CLOUDBOT_INSTANCE_BUDGET_MB', 10240, true),
        instanceCpus: readPositiveNumber(env, 'CLOUDBOT_INSTANCE_CPUS', 1.5),
        ownerName,
        containerId,
        aiMemory: readAiMemoryEnabled(env),
        ...(loginAllowedIps === undefined ? {} : { loginAllowedIps }),
        ...(googleClient === undefined ? {} : { googleClient }),
        ...(idleMs === undefined ? {} : { idleMs }),
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

function readDockerGuardSettings(env: NodeJS.ProcessEnv): DockerGuardSettings {
    return {
        upstream: new URL(env.DOCKER_GUARD_UPSTREAM ?? 'http://docker-proxy:2375'),
        port: Number(env.DOCKER_GUARD_PORT ?? '2375'),
        image: env.CLOUDBOT_INSTANCE_IMAGE ?? 'cloudbot:local',
        hubContainer: env.HUB_CONTAINER_ID ?? 'cloudbot-hub-1',
    };
}

export { readDockerGuardSettings, readHubSettings };
export type { DockerGuardSettings, HubSettings };
