interface DockerVolumeMount {
    source: string;
    target: string;
}

interface DockerContainerOptions {
    image: string;
    environment: string[];
    memoryBytes: number;
    nanoCpus: number;
    mounts: DockerVolumeMount[];
    networkName: string;
    containerAlias: string;
}

interface DockerEndpointConfig {
    Aliases: string[];
}

interface DockerContainerHostConfig {
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    RestartPolicy: DockerRestartPolicy;
    Privileged: false;
    Mounts: DockerApiMount[];
}

interface DockerRestartPolicy {
    Name: 'no';
}

interface DockerApiMount {
    Type: 'volume';
    Source: string;
    Target: string;
}

interface DockerContainerCreateBody {
    Image: string;
    Env: string[];
    HostConfig: DockerContainerHostConfig;
    NetworkingConfig: DockerNetworkingConfig;
}

interface DockerNetworkingConfig {
    EndpointsConfig: Record<string, DockerEndpointConfig>;
}

interface DockerContainerInspection {
    isRunning: boolean;
    state: string;
    healthStatus: string | undefined;
}

interface DockerApiClient {
    createNetwork: (name: string) => Promise<void>;
    removeNetwork: (name: string) => Promise<void>;
    connectContainerToNetwork: (networkName: string, containerName: string, aliases: string[]) => Promise<void>;
    disconnectContainerFromNetwork: (networkName: string, containerName: string) => Promise<void>;
    createVolume: (name: string) => Promise<void>;
    removeVolume: (name: string) => Promise<void>;
    createContainer: (name: string, options: DockerContainerOptions) => Promise<void>;
    inspectContainer: (name: string) => Promise<DockerContainerInspection | undefined>;
    startContainer: (name: string) => Promise<void>;
    stopContainer: (name: string) => Promise<void>;
    removeContainer: (name: string) => Promise<void>;
}

interface DockerRequestOptions {
    method: string;
    path: string;
    body?: unknown;
    ignoreNotFound?: boolean;
    acceptedStatuses?: number[];
}

interface DockerUnknownRecord {
    [key: string]: unknown;
}

class DockerApiError extends Error {
    readonly status: number;

    constructor(status: number, method: string, path: string) {
        super(`Docker API ${method} ${path} returned ${String(status)}.`);
        this.name = 'DockerApiError';
        this.status = status;
    }
}

class DockerApi implements DockerApiClient {
    private readonly baseUrl: string;
    private readonly fetchFunction: typeof fetch;

    constructor(baseUrl: string, fetchFunction: typeof fetch = fetch) {
        this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
        this.fetchFunction = fetchFunction;
    }

    async createNetwork(name: string): Promise<void> {
        const requestOptions: DockerRequestOptions = {
            method: 'POST',
            path: '/networks/create',
            // Not internal. An instance reaches AI providers and the web. Another person's network cannot reach it.
            body: { Name: name, Driver: 'bridge' },
        };

        await this.request(requestOptions);
    }

    async removeNetwork(name: string): Promise<void> {
        const requestOptions: DockerRequestOptions = {
            method: 'DELETE',
            path: `/networks/${encodeURIComponent(name)}`,
            ignoreNotFound: true,
        };

        await this.request(requestOptions);
    }

    async connectContainerToNetwork(networkName: string, containerName: string, aliases: string[]): Promise<void> {
        const requestOptions: DockerRequestOptions = {
            method: 'POST',
            path: `/networks/${encodeURIComponent(networkName)}/connect`,
            body: { Container: containerName, EndpointConfig: { Aliases: aliases } },
            // Docker answers 403 when the container is already on the network.
            acceptedStatuses: [403],
        };

        await this.request(requestOptions);
    }

    async disconnectContainerFromNetwork(networkName: string, containerName: string): Promise<void> {
        const requestOptions: DockerRequestOptions = {
            method: 'POST',
            path: `/networks/${encodeURIComponent(networkName)}/disconnect`,
            body: { Container: containerName, Force: true },
            ignoreNotFound: true,
        };

        await this.request(requestOptions);
    }

    async createVolume(name: string): Promise<void> {
        const requestOptions: DockerRequestOptions = {
            method: 'POST',
            path: '/volumes/create',
            body: { Name: name },
        };

        await this.request(requestOptions);
    }

    async removeVolume(name: string): Promise<void> {
        const requestOptions: DockerRequestOptions = {
            method: 'DELETE',
            path: `/volumes/${encodeURIComponent(name)}?force=true`,
            ignoreNotFound: true,
        };

        await this.request(requestOptions);
    }

    async createContainer(name: string, options: DockerContainerOptions): Promise<void> {
        const mounts: DockerApiMount[] = options.mounts.map(mount => ({ Type: 'volume' as const, Source: mount.source, Target: mount.target }));
        const hostConfig: DockerContainerHostConfig = {
            Memory: options.memoryBytes,
            MemorySwap: options.memoryBytes,
            NanoCpus: options.nanoCpus,
            RestartPolicy: { Name: 'no' },
            Privileged: false,
            Mounts: mounts,
        };
        const endpointConfig: DockerEndpointConfig = { Aliases: [options.containerAlias] };
        const endpointsConfig: Record<string, DockerEndpointConfig> = { [options.networkName]: endpointConfig };
        const networkingConfig: DockerNetworkingConfig = { EndpointsConfig: endpointsConfig };
        const requestBody: DockerContainerCreateBody = {
            Image: options.image,
            Env: options.environment,
            HostConfig: hostConfig,
            NetworkingConfig: networkingConfig,
        };
        const requestOptions: DockerRequestOptions = {
            method: 'POST',
            path: `/containers/create?name=${encodeURIComponent(name)}`,
            body: requestBody,
        };

        await this.request(requestOptions);
    }

    async inspectContainer(name: string): Promise<DockerContainerInspection | undefined> {
        const requestOptions: DockerRequestOptions = {
            method: 'GET',
            path: `/containers/${encodeURIComponent(name)}/json`,
            ignoreNotFound: true,
        };
        const response = await this.request(requestOptions);

        if (response === undefined) {
            return undefined;
        }

        const responseBody: unknown = await response.json();
        const record = this.readObject(responseBody);
        const state = this.readObject(record.State);
        const health = state.Health === undefined ? undefined : this.readObject(state.Health);
        const isRunning = state.Running;
        const stateName = state.Status;
        const healthStatus = health?.Status;

        if (typeof isRunning !== 'boolean' || typeof stateName !== 'string' || (healthStatus !== undefined && typeof healthStatus !== 'string')) {
            throw new Error('Docker returned an invalid container inspection.');
        }

        return { isRunning, state: stateName, healthStatus };
    }

    async startContainer(name: string): Promise<void> {
        const requestOptions: DockerRequestOptions = {
            method: 'POST',
            path: `/containers/${encodeURIComponent(name)}/start`,
            acceptedStatuses: [304],
        };

        await this.request(requestOptions);
    }

    async stopContainer(name: string): Promise<void> {
        const requestOptions: DockerRequestOptions = {
            method: 'POST',
            path: `/containers/${encodeURIComponent(name)}/stop?t=10`,
            acceptedStatuses: [304],
        };

        await this.request(requestOptions);
    }

    async removeContainer(name: string): Promise<void> {
        const requestOptions: DockerRequestOptions = {
            method: 'DELETE',
            path: `/containers/${encodeURIComponent(name)}?force=true&v=false`,
            ignoreNotFound: true,
        };

        await this.request(requestOptions);
    }

    private async request(options: DockerRequestOptions): Promise<Response | undefined> {
        const url = new URL(options.path, this.baseUrl);
        const headers: Record<string, string> = {};
        const requestInit: RequestInit = { method: options.method, headers };

        if (options.body !== undefined) {
            headers['content-type'] = 'application/json';
            requestInit.body = JSON.stringify(options.body);
        }

        const response = await this.fetchFunction(url, requestInit);

        if (response.status === 404 && options.ignoreNotFound === true) {
            return undefined;
        }

        const acceptedStatuses = options.acceptedStatuses ?? [];

        if (!response.ok && !acceptedStatuses.includes(response.status)) {
            throw new DockerApiError(response.status, options.method, url.pathname);
        }

        return response;
    }

    private readObject(value: unknown): DockerUnknownRecord {
        const isObject = typeof value === 'object' && value !== null && !Array.isArray(value);

        if (!isObject) {
            throw new Error('Docker returned an invalid container inspection.');
        }

        return value as DockerUnknownRecord;
    }
}

export { DockerApi, DockerApiError };
export type { DockerApiClient, DockerContainerInspection, DockerContainerOptions, DockerVolumeMount };
