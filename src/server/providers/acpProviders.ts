import { join } from 'node:path';

import { AcpEngine } from '../agent/AcpEngine.ts';
import type { AgentEvent } from '../agent/AgentEvent.ts';
import type { AgentRunner, TurnRequest } from '../agent/AgentRunner.ts';
import { signalProcessTree } from '../agent/ClaudeCliEngine.ts';
import { PROVIDER_AGENT_WRAPPER, wrapperAgentLaunch } from '../agent/codexAgentLaunch.ts';
import type { LoopbackToolServer } from '../agent/createLoopbackToolServer.ts';
import type { ProviderApiKey, ProviderMethod, ProviderSignIn } from '../setup/SetupConversation.ts';
import { startKeyProxy } from '../vault/KeyProxy.ts';
import type { KeyHeader, KeyProxy } from '../vault/KeyProxy.ts';
import type { Vault } from '../vault/Vault.ts';
import { createCliSignIn } from './createCliSignIn.ts';
import type { ProviderEngine } from './ProviderRunner.ts';
import type { ProviderId } from './providerIds.ts';

type AcpProviderId = Exclude<ProviderId, 'claude' | 'chatgpt'>;

interface AcpSignInSpec {
    site: string;
    // The ACP auth method that loads the cached sign-in, for an agent that needs one before a session.
    authMethodId?: string | undefined;
    needsCode?: boolean | undefined;
    optionLabel?: string | undefined;
    // True for a provider that needs no sign-in, like the free opencode models.
    isFree?: boolean | undefined;
}

interface AcpApiKeySpec {
    site: string;
    secretName: string;
    upstreamUrl: string;
    keyHeader: KeyHeader;
    // A cheap call that answers 401 or 403 for a wrong key.
    checkUrl: string;
    // Google answers a wrong key with 400 API_KEY_INVALID instead of 401.
    badKeyStatus?: number | undefined;
    // The variables that point the CLI at the key proxy. The key the CLI sees is a placeholder.
    environment: (proxyUrl: string) => Record<string, string>;
    // A key that runs on another CLI, like an xAI key on opencode, since Grok Build takes only a Grok account over ACP.
    // The wrapper action and, in local mode, the provider whose CLI runs it.
    runsOn?: { action: string; localProvider: AcpProviderId; protectedFolders: string[] } | undefined;
}

interface AcpProviderSpec {
    id: AcpProviderId;
    label: string;
    // Folders the CLI loads its sign-in or config from, see AcpEngine. A question that names one is refused.
    protectedFolders: string[];
    // The session mode that asks before each tool, when the default mode does not.
    askModeId?: string | undefined;
    signIn?: AcpSignInSpec | undefined;
    apiKey?: AcpApiKeySpec | undefined;
}

interface AcpProvidersOptions {
    agentUser: string | undefined;
    vault: Vault;
    loopback: LoopbackToolServer;
    // The way each provider was connected last, read when a turn starts.
    methodFor: (provider: ProviderId) => Promise<ProviderMethod | undefined>;
    // A folder for the CLIs in local mode. Docker runs them as the agent user, in its own home.
    dataDir: string;
    // Local mode runs a CLI only when its absolute path is given, such as CLOUDBOT_GEMINI_PATH.
    localPaths: Partial<Record<AcpProviderId, string>>;
}

interface AcpProviders {
    engines: Partial<Record<ProviderId, ProviderEngine>>;
    signIns: ProviderSignIn[];
    apiKeys: ProviderApiKey[];
    available: ProviderId[];
    close: () => Promise<void>;
}

const PLACEHOLDER_KEY = 'cloudbot-key-proxy';
const OPENCODE_FOLDERS = ['.opencode', 'opencode.json', 'opencode.jsonc', '.config/opencode', '.local/share/opencode'];
const BEARER: KeyHeader = { name: 'authorization', prefix: 'Bearer ' };
// How long a sign-in check is trusted, so a turn does not start the CLI twice.
const STATUS_CACHE_MS = 5 * 60 * 1000;

// Each provider was checked against its real CLI, see docs/ARCHITECTURE.md. The local commands match the ones in
// docker/cloudbot-provider, which the Docker image runs instead.
const ACP_PROVIDERS: AcpProviderSpec[] = [
    {
        id: 'gemini',
        label: 'Gemini',
        protectedFolders: ['.gemini'],
        signIn: { site: 'Google', authMethodId: 'oauth-personal', needsCode: true },
        apiKey: {
            site: 'Google AI Studio',
            secretName: 'GEMINI_API_KEY',
            upstreamUrl: 'https://generativelanguage.googleapis.com',
            keyHeader: { name: 'x-goog-api-key', prefix: '' },
            checkUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
            badKeyStatus: 400,
            environment: proxyUrl => ({ GEMINI_API_KEY: PLACEHOLDER_KEY, GOOGLE_GEMINI_BASE_URL: proxyUrl }),
        },
    },
    {
        id: 'copilot',
        label: 'GitHub Copilot',
        protectedFolders: ['.copilot', '.github/hooks'],
        signIn: { site: 'GitHub' },
    },
    {
        id: 'cursor',
        label: 'Cursor',
        protectedFolders: ['.cursor', '.config/cursor'],
        signIn: { site: 'Cursor', authMethodId: 'cursor_login' },
    },
    {
        id: 'grok',
        label: 'Grok',
        protectedFolders: ['.grok'],
        signIn: { site: 'xAI', authMethodId: 'grok.com' },
        apiKey: {
            site: 'the xAI console',
            secretName: 'XAI_API_KEY',
            upstreamUrl: 'https://api.x.ai',
            keyHeader: BEARER,
            checkUrl: 'https://api.x.ai/v1/models',
            // The Docker wrapper builds the same opencode config from CLOUDBOT_KEY_PROXY_URL, since sudo drops other names.
            environment: proxyUrl => ({
                CLOUDBOT_KEY_PROXY_URL: proxyUrl,
                OPENCODE_CONFIG_CONTENT: JSON.stringify({
                    permission: { '*': 'ask' },
                    autoupdate: false,
                    model: 'xai/grok-4.7',
                    provider: { xai: { options: { baseURL: `${proxyUrl}/v1`, apiKey: PLACEHOLDER_KEY } } },
                }),
            }),
            runsOn: { action: 'acp-key', localProvider: 'opencode', protectedFolders: OPENCODE_FOLDERS },
        },
    },
    {
        id: 'mistral',
        label: 'Mistral',
        protectedFolders: ['.vibe'],
        askModeId: 'ask',
        signIn: { site: 'Mistral AI Studio' },
        apiKey: {
            site: 'Mistral AI Studio',
            secretName: 'MISTRAL_API_KEY',
            upstreamUrl: 'https://api.mistral.ai',
            keyHeader: BEARER,
            checkUrl: 'https://api.mistral.ai/v1/models',
            // Vibe takes its providers from VIBE_PROVIDERS, which replaces the default Mistral endpoint with the proxy.
            environment: proxyUrl => ({
                MISTRAL_API_KEY: PLACEHOLDER_KEY,
                VIBE_PROVIDERS: JSON.stringify([{ name: 'mistral', api_base: `${proxyUrl}/v1`, api_key_env_var: 'MISTRAL_API_KEY' }]),
            }),
        },
    },
    {
        id: 'qwen',
        label: 'Qwen',
        protectedFolders: ['.qwen'],
        apiKey: {
            site: 'Alibaba Cloud Model Studio',
            secretName: 'DASHSCOPE_API_KEY',
            upstreamUrl: 'https://dashscope-intl.aliyuncs.com',
            keyHeader: BEARER,
            checkUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models',
            environment: proxyUrl => ({ OPENAI_API_KEY: PLACEHOLDER_KEY, OPENAI_BASE_URL: `${proxyUrl}/compatible-mode/v1` }),
        },
    },
    {
        id: 'kimi',
        label: 'Kimi',
        protectedFolders: ['.kimi', '.kimi-code'],
        signIn: { site: 'Kimi' },
        apiKey: {
            site: 'the Moonshot AI platform',
            secretName: 'MOONSHOT_API_KEY',
            upstreamUrl: 'https://api.moonshot.ai',
            keyHeader: BEARER,
            checkUrl: 'https://api.moonshot.ai/v1/models',
            // Kimi Code adds a model from these variables and picks it over a signed-in account.
            environment: proxyUrl => ({
                KIMI_MODEL_NAME: 'kimi-k3',
                KIMI_MODEL_PROVIDER_TYPE: 'kimi',
                KIMI_MODEL_API_KEY: PLACEHOLDER_KEY,
                KIMI_MODEL_BASE_URL: `${proxyUrl}/v1`,
            }),
        },
    },
    {
        id: 'opencode',
        label: 'opencode',
        protectedFolders: OPENCODE_FOLDERS,
        signIn: { site: 'opencode', isFree: true, optionLabel: 'opencode free models' },
    },
];

const LOCAL_ACP_ARGS: Record<AcpProviderId, string[]> = {
    gemini: ['--acp'],
    copilot: ['--acp', '--stdio'],
    cursor: ['acp'],
    grok: ['--no-auto-update', 'agent', 'stdio'],
    mistral: [],
    qwen: ['--acp', '--auth-type', 'openai'],
    kimi: ['acp'],
    opencode: ['acp'],
};
const LOCAL_LOGIN_ARGS: Partial<Record<AcpProviderId, string[]>> = {
    copilot: ['login', '--device-code'],
    cursor: ['login'],
    grok: ['login', '--device-auth'],
    kimi: ['login'],
};

// Local mode runs a provider only when its CLI path is set, such as CLOUDBOT_GEMINI_PATH=/usr/local/bin/gemini.
function readLocalAcpPaths(environment: NodeJS.ProcessEnv): Partial<Record<AcpProviderId, string>> {
    const entries = ACP_PROVIDERS.map(spec => [spec.id, environment[`CLOUDBOT_${spec.id.toUpperCase()}_PATH`]] as const)
        .filter(([, path]) => path?.startsWith('/') === true);

    return Object.fromEntries(entries);
}

async function checkKeyAt(url: string, keyHeader: KeyHeader, key: string, badKeyStatus?: number): Promise<number> {
    const response = await fetch(url, { headers: { [keyHeader.name]: `${keyHeader.prefix}${key}` }, redirect: 'manual' });

    return response.status === badKeyStatus ? 401 : response.status;
}

// Runs a turn with the sign-in or the key, whichever way the owner connected the provider last.
function methodRunner(signInRunner: AgentRunner | undefined, keyRunner: AgentRunner | undefined, method: () => Promise<ProviderMethod | undefined>): AgentRunner {
    return {
        async* runTurn(request: TurnRequest): AsyncGenerator<AgentEvent> {
            const chosen = await method();
            const runner = chosen === 'apiKey' ? keyRunner ?? signInRunner : signInRunner ?? keyRunner;

            if (runner !== undefined) {
                yield* runner.runTurn(request);
            }
        },
    };
}

// Builds the engines, sign-ins and API keys of the providers that run over the Agent Client Protocol.
async function createAcpProviders(options: AcpProvidersOptions): Promise<AcpProviders> {
    const isAgentMode = options.agentUser !== undefined;
    const usable = ACP_PROVIDERS.filter(spec => isAgentMode || options.localPaths[spec.id] !== undefined);
    const proxies: KeyProxy[] = [];
    const engines: Partial<Record<ProviderId, ProviderEngine>> = {};
    const signIns: ProviderSignIn[] = [];
    const apiKeys: ProviderApiKey[] = [];
    const launch = options.agentUser === undefined ? undefined : wrapperAgentLaunch(options.agentUser, PROVIDER_AGENT_WRAPPER);
    const signalLocal = launch?.signalProcess ?? ((child, action): void => {
        signalProcessTree(child, action, undefined);
    });

    const built = usable.map(async (spec) => {
        const localPath = options.localPaths[spec.id] ?? PROVIDER_AGENT_WRAPPER;
        const command = launch === undefined ? localPath : PROVIDER_AGENT_WRAPPER;
        const args = launch === undefined ? LOCAL_ACP_ARGS[spec.id] : [spec.id, 'acp'];
        const home = join(options.dataDir, 'providers', spec.id, 'home');
        const signInEngine = spec.signIn === undefined
            ? undefined
            : new AcpEngine({
                    label: spec.label, command, args, homeFor: () => home, loopback: options.loopback, launch,
                    authMethodId: spec.signIn.authMethodId, askModeId: spec.askModeId, protectedFolders: spec.protectedFolders,
                });
        const keySpec = spec.apiKey;
        const runsOn = keySpec?.runsOn;
        // A key that runs on another CLI needs that CLI. In local mode its path must be set too.
        const keyCommand = launch === undefined && runsOn !== undefined ? options.localPaths[runsOn.localProvider] : command;
        const keyArgs = runsOn === undefined ? args : launch === undefined ? LOCAL_ACP_ARGS[runsOn.localProvider] : [spec.id, runsOn.action];
        const canUseKey = keySpec !== undefined && keyCommand !== undefined;
        const proxy = canUseKey ? await startKeyProxy({ vault: options.vault, secretName: keySpec.secretName, upstreamUrl: keySpec.upstreamUrl, keyHeader: keySpec.keyHeader }) : undefined;
        const keyEngine = proxy === undefined || keySpec === undefined || keyCommand === undefined
            ? undefined
            : new AcpEngine({
                    label: spec.label, command: keyCommand, args: keyArgs, homeFor: () => home, loopback: options.loopback, launch,
                    environment: keySpec.environment(proxy.url), askModeId: runsOn === undefined ? spec.askModeId : undefined,
                    protectedFolders: [...spec.protectedFolders, ...(runsOn?.protectedFolders ?? [])],
                });

        if (proxy !== undefined) {
            proxies.push(proxy);
        }

        let checkedAt = 0;
        const isSignedIn = async (): Promise<boolean | undefined> => {
            if (signInEngine === undefined) {
                return false;
            }

            if (Date.now() - checkedAt < STATUS_CACHE_MS) {
                return true;
            }

            // The agent user cannot enter the data folder, so its check runs in /tmp, which holds nothing of the bots.
            const checkFolder = launch === undefined ? home : '/tmp';
            const status = await signInEngine.isSignedIn('setup', checkFolder);

            checkedAt = status === true ? Date.now() : 0;

            return status;
        };

        if (spec.signIn !== undefined) {
            const signInSpec = spec.signIn;
            const loginArgs = launch === undefined ? LOCAL_LOGIN_ARGS[spec.id] : [spec.id, 'login'];

            signIns.push(signInSpec.isFree === true || loginArgs === undefined
                ? {
                        id: spec.id, label: spec.label, site: signInSpec.site, optionLabel: signInSpec.optionLabel, isSignedIn,
                        // A free provider has nothing to sign in to, so its sign-in ends at once.
                        start: () => ({ link: Promise.resolve(null), finished: Promise.resolve({ ok: true }), cancel: () => undefined }),
                    }
                : createCliSignIn({
                        id: spec.id, label: spec.label, site: signInSpec.site, optionLabel: signInSpec.optionLabel, needsCode: signInSpec.needsCode,
                        command, args: loginArgs, environment: { PATH: process.env.PATH ?? '', HOME: home }, isSignedIn,
                        spawnFunction: launch?.spawnFunction, signalProcess: signalLocal,
                    }));
        }

        if (keySpec !== undefined && keyEngine !== undefined) {
            apiKeys.push({
                id: spec.id, label: spec.label, site: keySpec.site, secretName: keySpec.secretName,
                checkKey: key => checkKeyAt(keySpec.checkUrl, keySpec.keyHeader, key, keySpec.badKeyStatus),
            });
        }

        engines[spec.id] = {
            runner: methodRunner(signInEngine, keyEngine, () => options.methodFor(spec.id)),
            isConnected: async () => {
                const method = await options.methodFor(spec.id);

                if (method === 'apiKey' && keySpec !== undefined) {
                    return options.vault.has(keySpec.secretName);
                }

                return await isSignedIn() === true;
            },
        };
    });

    await Promise.all(built);

    // The providers are built at the same time, so the lists are put back in the fixed order for the setup chat.
    const order = (id: string): number => ACP_PROVIDERS.findIndex(spec => spec.id === id);

    signIns.sort((first, second) => order(first.id) - order(second.id));
    apiKeys.sort((first, second) => order(first.id) - order(second.id));

    return {
        engines,
        signIns,
        apiKeys,
        available: usable.map(spec => spec.id),
        close: async () => {
            const closing = proxies.map(proxy => proxy.close());

            await Promise.all(closing);
        },
    };
}

export { ACP_PROVIDERS, BEARER, PLACEHOLDER_KEY, checkKeyAt, createAcpProviders, methodRunner, readLocalAcpPaths };
export type { AcpProviderSpec, AcpProviders };
