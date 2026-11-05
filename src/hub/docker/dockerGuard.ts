// The hub talks to Docker through this guard. It lets through only the requests the hub makes, for the names the hub
// uses, so a hub taken over cannot start a privileged container, mount the host or touch other containers.

interface DockerGuardRules {
    image: string;
    hubContainer: string;
}

interface DockerGuardRequest {
    method: string;
    path: string;
    query: URLSearchParams;
    body: unknown;
}

interface GuardRecord {
    [key: string]: unknown;
}

interface GuardRoute {
    method: string;
    pattern: RegExp;
    check: (request: DockerGuardRequest, rules: DockerGuardRules) => boolean;
}

const NAME = '[a-z0-9][a-z0-9-]{0,80}';
const CONTAINER_PATTERN = new RegExp(`^cloudbot-i-${NAME}$`);
const NETWORK_PATTERN = new RegExp(`^cloudbot-net-${NAME}$`);
const VOLUME_PATTERN = new RegExp(`^cbi-${NAME}$`);
const HOST_CONFIG_KEYS = ['Memory', 'MemorySwap', 'NanoCpus', 'RestartPolicy', 'Privileged', 'Mounts', 'PidsLimit', 'LogConfig'];

function isRecord(value: unknown): value is GuardRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The record has only these keys. A key Docker knows but the hub never sends, like Binds or CapAdd, is refused.
function hasOnlyKeys(value: unknown, keys: string[]): value is GuardRecord {
    return isRecord(value) && Object.keys(value)
        .every(key => keys.includes(key));
}

function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isPositiveNumber(value: unknown): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isVolumeMount(mount: unknown): boolean {
    return hasOnlyKeys(mount, ['Type', 'Source', 'Target'])
        && mount.Type === 'volume'
        && typeof mount.Source === 'string'
        && VOLUME_PATTERN.test(mount.Source)
        && typeof mount.Target === 'string'
        && mount.Target.startsWith('/');
}

function isHostConfig(hostConfig: unknown): boolean {
    if (!hasOnlyKeys(hostConfig, HOST_CONFIG_KEYS)) {
        return false;
    }

    const mounts = hostConfig.Mounts;
    const restartPolicy = hostConfig.RestartPolicy;
    const logConfig = hostConfig.LogConfig;

    return hostConfig.Privileged === false
        && isPositiveNumber(hostConfig.Memory)
        && isPositiveNumber(hostConfig.MemorySwap)
        && isPositiveNumber(hostConfig.NanoCpus)
        && isPositiveNumber(hostConfig.PidsLimit)
        && hasOnlyKeys(restartPolicy, ['Name'])
        && restartPolicy.Name === 'no'
        && hasOnlyKeys(logConfig, ['Type', 'Config'])
        && logConfig.Type === 'json-file'
        && Array.isArray(mounts)
        && mounts.every(isVolumeMount);
}

function isNetworkingConfig(networkingConfig: unknown): boolean {
    if (!hasOnlyKeys(networkingConfig, ['EndpointsConfig']) || !isRecord(networkingConfig.EndpointsConfig)) {
        return false;
    }

    const endpoints = Object.entries(networkingConfig.EndpointsConfig);

    return endpoints.length === 1 && endpoints.every(([network, endpoint]) => NETWORK_PATTERN.test(network)
        && hasOnlyKeys(endpoint, ['Aliases'])
        && isStringList(endpoint.Aliases)
        && endpoint.Aliases.every(alias => CONTAINER_PATTERN.test(alias)));
}

function checkContainerCreate(request: DockerGuardRequest, rules: DockerGuardRules): boolean {
    const name = request.query.get('name') ?? '';
    const body = request.body;

    return CONTAINER_PATTERN.test(name)
        && hasOnlyKeys(body, ['Image', 'Env', 'HostConfig', 'NetworkingConfig'])
        && body.Image === rules.image
        && isStringList(body.Env)
        && isHostConfig(body.HostConfig)
        && isNetworkingConfig(body.NetworkingConfig);
}

function checkNetworkCreate(request: DockerGuardRequest): boolean {
    const body = request.body;

    return hasOnlyKeys(body, ['Name', 'Driver']) && typeof body.Name === 'string' && NETWORK_PATTERN.test(body.Name) && body.Driver === 'bridge';
}

function checkHubConnect(request: DockerGuardRequest, rules: DockerGuardRules): boolean {
    const body = request.body;

    if (!hasOnlyKeys(body, ['Container', 'EndpointConfig']) || !hasOnlyKeys(body.EndpointConfig, ['Aliases'])) {
        return false;
    }

    const aliases = body.EndpointConfig.Aliases;

    return body.Container === rules.hubContainer && isStringList(aliases) && aliases.join() === 'hub';
}

function checkHubDisconnect(request: DockerGuardRequest, rules: DockerGuardRules): boolean {
    const body = request.body;

    return hasOnlyKeys(body, ['Container', 'Force']) && body.Container === rules.hubContainer;
}

function checkVolumeCreate(request: DockerGuardRequest): boolean {
    const body = request.body;

    return hasOnlyKeys(body, ['Name']) && typeof body.Name === 'string' && VOLUME_PATTERN.test(body.Name);
}

function allowed(): boolean {
    return true;
}

// Every request DockerApi makes, and nothing else.
const ROUTES: GuardRoute[] = [
    { method: 'POST', pattern: /^\/containers\/create$/, check: checkContainerCreate },
    { method: 'GET', pattern: new RegExp(`^/containers/cloudbot-i-${NAME}/json$`), check: allowed },
    { method: 'POST', pattern: new RegExp(`^/containers/cloudbot-i-${NAME}/(?:start|stop)$`), check: allowed },
    { method: 'DELETE', pattern: new RegExp(`^/containers/cloudbot-i-${NAME}$`), check: allowed },
    // The health check of the guard. Docker answers OK and nothing else.
    { method: 'GET', pattern: /^\/_ping$/, check: allowed },
    { method: 'POST', pattern: /^\/networks\/create$/, check: checkNetworkCreate },
    { method: 'DELETE', pattern: new RegExp(`^/networks/cloudbot-net-${NAME}$`), check: allowed },
    { method: 'POST', pattern: new RegExp(`^/networks/cloudbot-net-${NAME}/connect$`), check: checkHubConnect },
    { method: 'POST', pattern: new RegExp(`^/networks/cloudbot-net-${NAME}/disconnect$`), check: checkHubDisconnect },
    { method: 'POST', pattern: /^\/volumes\/create$/, check: checkVolumeCreate },
    { method: 'DELETE', pattern: new RegExp(`^/volumes/cbi-${NAME}$`), check: allowed },
];

function isAllowedDockerRequest(request: DockerGuardRequest, rules: DockerGuardRules): boolean {
    const route = ROUTES.find(candidate => candidate.method === request.method && candidate.pattern.test(request.path));

    return route !== undefined && route.check(request, rules);
}

export { isAllowedDockerRequest };
export type { DockerGuardRequest, DockerGuardRules };
