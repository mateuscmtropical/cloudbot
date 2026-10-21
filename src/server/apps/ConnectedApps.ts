import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import type { ConnectedAppSummary } from '../../shared/connectedApps.ts';
import type { BotSecrets } from '../secrets/BotSecrets.ts';
import type { ConnectedAppRecord, ConnectedAppStore } from '../store/ConnectedAppStore.ts';
import { PROFILE_SERVER_NAME } from '../agent/createProfileToolServer.ts';
import type { AppProxy } from './AppProxy.ts';
import { AppAddressError, checkAppUrl, defaultAppAddressDeps } from './appAddress.ts';
import type { AllowedPrivateHost, AppAddressDeps, CheckedAppUrl } from './appAddress.ts';
import { pinnedFetch } from './pinnedFetch.ts';
import { probeAppServer } from './probeAppServer.ts';
import type { FetchFunction, ProbeResult } from './probeAppServer.ts';

// The read and write parts of the bot secrets that connecting needs.
type AppSecrets = Pick<BotSecrets, 'read' | 'remove'>;

interface ConnectInput {
    name: string;
    url: string;
    // The name of a secret the bot saved with request_secret. It holds the token of the server.
    tokenSecret: string | undefined;
}

// What the bot is told. A refusal explains what to fix, and never names an address of this machine.
type ConnectOutcome
    = | { outcome: 'connected'; name: string; toolCount: number }
        | { outcome: 'needs_token'; name: string; origin: string }
        | { outcome: 'refused'; problem: string }
        | { outcome: 'failed'; problem: string };

interface ConnectedAppsDeps {
    store: ConnectedAppStore;
    secrets: AppSecrets;
    proxy: AppProxy;
    // The hosts and ports the owner allowed the browser to reach. Only those may be private.
    allowedHosts: () => Promise<AllowedPrivateHost[]>;
    addressDeps?: ((allowedHosts: AllowedPrivateHost[]) => AppAddressDeps) | undefined;
    fetchFunction?: FetchFunction | undefined;
}

// A token that is not usable for an address is reported as a problem, and the proxy never sends the request without it.
interface TokenRead {
    value: string | undefined;
    problem?: string | undefined;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
const NAME_RULE = 'Use 2 to 31 lowercase letters, digits and hyphens, starting with a letter.';
const HTTPS_PROTOCOL = 'https:';

// The probe sends to the addresses checked at connect time, never to a second lookup.
function pinnedFetchFor(addresses: string[]): FetchFunction {
    return (target, init) => {
        const targetUrl = new URL(target);

        return pinnedFetch(targetUrl, init, addresses);
    };
}

// The old connection stays when a new address does not connect, so the owner's working server is not lost.
function keptConnectionProblem(name: string, probe: ProbeResult): string {
    if (probe.status === 'needs_token') {
        return `The new address of "${name}" needs a token, so its old connection stays. Ask the owner to fill in the secure form first.`;
    }

    const problem = probe.status === 'failed' ? probe.problem : '';

    return `The new address of "${name}" did not connect, so its old connection stays. ${problem}`;
}

// Connected servers and their tokens. The bot reaches a server through the app proxy, which adds the token from the vault.
class ConnectedApps {
    private readonly deps: ConnectedAppsDeps;

    constructor(deps: ConnectedAppsDeps) {
        this.deps = deps;
    }

    // Puts the connected servers back behind the proxy, since its addresses live in memory only.
    async start(): Promise<void> {
        const records = await this.deps.store.list();

        records
            .filter(record => record.status === 'connected')
            .forEach((record) => {
                this.registerRoute(record);
            });
    }

    async connect(botId: string, input: ConnectInput): Promise<ConnectOutcome> {
        if (!NAME_PATTERN.test(input.name) || input.name === PROFILE_SERVER_NAME) {
            return { outcome: 'refused', problem: `That server name is not valid. ${NAME_RULE}` };
        }

        const allowedHosts = await this.deps.allowedHosts();
        const addressDeps = this.deps.addressDeps === undefined ? defaultAppAddressDeps(allowedHosts) : this.deps.addressDeps(allowedHosts);
        let checked: CheckedAppUrl;

        try {
            checked = await checkAppUrl(input.url, addressDeps);
        } catch (error: unknown) {
            return { outcome: 'refused', problem: error instanceof AppAddressError ? error.message : 'That address could not be checked.' };
        }

        const token = this.readTokenFor(botId, input.tokenSecret, checked.url);

        if (token.problem !== undefined) {
            return { outcome: 'refused', problem: token.problem };
        }

        const probe = await this.probe(checked, token.value);

        return this.saveProbe(input, checked.url, probe, botId, input.tokenSecret);
    }

    async list(): Promise<ConnectedAppSummary[]> {
        const records = await this.deps.store.list();

        return records.map(toSummary);
    }

    async remove(id: string): Promise<boolean> {
        const record = await this.deps.store.findById(id);

        if (record === undefined) {
            return false;
        }

        this.deps.proxy.remove(record.id);

        const removed = await this.deps.store.remove(id);

        await this.dropReplacedSecret(record);

        return removed;
    }

    // Removes the servers whose token this bot saved, since the token goes with the bot. Servers without a token are shared and stay.
    async removeSavedBy(botId: string): Promise<void> {
        const records = await this.deps.store.list();
        const savedRecords = records.filter(record => record.secretBotId === botId);

        const removals = savedRecords.map(record => this.remove(record.id));

        await Promise.all(removals);
    }

    // The MCP servers of one turn. Each one points at the proxy, never at the server itself.
    async serverConfigs(): Promise<Record<string, McpServerConfig>> {
        const records = await this.deps.store.list();
        const configs: Record<string, McpServerConfig> = {};

        records
            .filter(record => record.status === 'connected')
            .forEach((record) => {
                const address = this.deps.proxy.addressOf(record.id);

                if (address !== undefined) {
                    configs[record.name] = { type: 'http', url: address };
                }
            });

        return configs;
    }

    // The token is read only for an https address, and only when the saved secret is for the same origin.
    private readTokenFor(botId: string, tokenSecret: string | undefined, url: URL): TokenRead {
        if (tokenSecret === undefined) {
            return { value: undefined };
        }

        if (url.protocol !== HTTPS_PROTOCOL) {
            return { value: undefined, problem: 'A token is sent only to an https address.' };
        }

        const secret = this.deps.secrets.read(botId, tokenSecret);

        if (secret === undefined) {
            return { value: undefined, problem: 'That secret is not saved yet. Ask the owner to fill in the secure form first.' };
        }

        if (secret.site !== url.origin) {
            return { value: undefined, problem: 'The saved secret is for another site, so it is not sent here.' };
        }

        return { value: secret.value };
    }

    private async probe(checked: CheckedAppUrl, token: string | undefined): Promise<ProbeResult> {
        const fetchFunction = this.deps.fetchFunction ?? pinnedFetchFor(checked.addresses);

        return probeAppServer(checked.url.href, token, fetchFunction);
    }

    private async saveProbe(
        input: ConnectInput,
        url: URL,
        probe: ProbeResult,
        botId: string,
        tokenSecret: string | undefined,
    ): Promise<ConnectOutcome> {
        const previous = await this.deps.store.findByName(input.name);

        if (previous?.status === 'connected' && probe.status !== 'connected') {
            return { outcome: 'refused', problem: keptConnectionProblem(input.name, probe) };
        }

        const outcome = await this.storeProbe(input, url, probe, botId, tokenSecret);

        await this.dropReplacedSecret(previous);

        return outcome;
    }

    private async storeProbe(
        input: ConnectInput,
        url: URL,
        probe: ProbeResult,
        botId: string,
        tokenSecret: string | undefined,
    ): Promise<ConnectOutcome> {
        const isWithToken = tokenSecret !== undefined;
        const base = {
            name: input.name,
            url: url.href,
            secretName: isWithToken ? tokenSecret : undefined,
            secretBotId: isWithToken ? botId : undefined,
        };

        if (probe.status === 'connected') {
            const record = await this.deps.store.save({ ...base, status: 'connected', toolCount: probe.toolCount, problem: undefined });

            this.registerRoute(record);

            return { outcome: 'connected', name: input.name, toolCount: probe.toolCount };
        }

        if (probe.status === 'needs_token') {
            const record = await this.deps.store.save({ ...base, status: 'needs_token', toolCount: 0, problem: undefined, secretName: undefined, secretBotId: undefined });

            this.deps.proxy.remove(record.id);

            return { outcome: 'needs_token', name: input.name, origin: url.origin };
        }

        const record = await this.deps.store.save({ ...base, status: 'failed', toolCount: 0, problem: probe.problem });

        this.deps.proxy.remove(record.id);

        return { outcome: 'failed', problem: probe.problem };
    }

    // A vault secret is deleted only when no row uses it any more, since two servers may share one token.
    private async dropReplacedSecret(previous: ConnectedAppRecord | undefined): Promise<void> {
        if (previous === undefined || previous.secretBotId === null || previous.secretName === null) {
            return;
        }

        const isInUse = await this.deps.store.isSecretInUse(previous.secretBotId, previous.secretName);

        if (!isInUse) {
            this.deps.secrets.remove(previous.secretBotId, previous.secretName);
        }
    }

    // The token is read again for each request, and the site is checked then too, since the secret may have been saved again.
    private registerRoute(record: ConnectedAppRecord): void {
        const upstream = new URL(record.url);
        const secretName = record.secretName;
        const secretBotId = record.secretBotId;

        this.deps.proxy.register(record.id, {
            upstream,
            readToken: () => {
                if (secretName === null || secretBotId === null) {
                    return undefined;
                }

                const token = this.readTokenFor(secretBotId, secretName, upstream);

                if (token.problem !== undefined) {
                    throw new Error(token.problem);
                }

                return token.value;
            },
        });
    }
}

function toSummary(record: ConnectedAppRecord): ConnectedAppSummary {
    return {
        id: record.id,
        name: record.name,
        url: record.url,
        status: record.status,
        toolCount: record.toolCount,
        ...(record.problem === null ? {} : { problem: record.problem }),
    };
}

export { ConnectedApps, NAME_PATTERN, NAME_RULE };
export type { ConnectInput, ConnectOutcome, ConnectedAppsDeps };
