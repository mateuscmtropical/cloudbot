import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { validateAgentIsolation } from './agent/buildClaudeCommand.ts';

import { CLEANUP_INTERVAL_MS } from './attachments/cleanUploads.ts';
import { SdkAgentRunner } from './agent/SdkAgentRunner.ts';
import { SetupAccess } from './access/SetupAccess.ts';
import { buildSetupLink, readPublicBaseUrl, readServerPort } from './access/setupLinkUrl.ts';
import { createClaudeReviewModel } from './approvals/createClaudeReviewModel.ts';
import { createReviewContextReader } from './approvals/createReviewContextReader.ts';
import { createToolCallReviewer } from './approvals/createToolCallReviewer.ts';
import { ChatService } from './chat/ChatService.ts';
import { createApp } from './createApp.ts';
import { ScreenHolder } from './desktop/ScreenHolder.ts';
import { attachVncProxy } from './desktop/attachVncProxy.ts';
import { BrowserControl, DESKTOP_DEVTOOLS_URL } from './desktop/BrowserControl.ts';
import { BrowserGate } from './desktop/BrowserGate.ts';
import { DesktopSupervisor, buildDesktopCommand } from './desktop/DesktopSupervisor.ts';
import { BotStore } from './store/BotStore.ts';
import { BrowserAllowStore } from './store/BrowserAllowStore.ts';
import { MessageStore } from './store/MessageStore.ts';
import { RoutineScheduler } from './routines/RoutineScheduler.ts';
import { RoutineStore } from './store/RoutineStore.ts';
import { IntegrationStore } from './store/IntegrationStore.ts';
import { IntegrationService } from './integrations/IntegrationService.ts';
import { AGENT_WORKSPACE_ROOT, agentWorkspacePath } from './agent/prepareAgentWorkspace.ts';
import { asIntegrationUser, runCleanup, runIntegrationProcess } from './integrations/runIntegrationProcess.ts';
import { RuleStore } from './store/RuleStore.ts';
import { LimitStore } from './store/LimitStore.ts';
import { ModelStore } from './store/ModelStore.ts';
import { WebhookStore } from './store/WebhookStore.ts';
import { DeliveryMemory, WebhookRefusalLog } from './webhooks/webhookMemory.ts';
import { WatchStore } from './store/WatchStore.ts';
import { WatchScheduler } from './watches/WatchScheduler.ts';
import { fetchWatchedPage } from './watches/fetchWatchedPage.ts';
import { ensureDefaultBot } from './store/ensureDefaultBot.ts';
import { openDatabase } from './store/openDatabase.ts';
import { databasePath, resolveDataDir } from './store/resolveDataDir.ts';
import { SettingsStore } from './store/SettingsStore.ts';
import { checkApiKey } from './setup/checkApiKey.ts';
import { SetupConversation, API_KEY_NAME } from './setup/SetupConversation.ts';
import { startClaudeLogin } from './claudeAuth/startClaudeLogin.ts';
import { getClaudeAuthStatus } from './claudeAuth/getClaudeAuthStatus.ts';
import { BotSecrets } from './secrets/BotSecrets.ts';
import { Vault } from './vault/Vault.ts';
import { startKeyProxy } from './vault/KeyProxy.ts';
import type { KeyProxy } from './vault/KeyProxy.ts';
import { AppProxy } from './apps/AppProxy.ts';
import { ConnectedApps } from './apps/ConnectedApps.ts';
import { GithubProxy } from './github/GithubProxy.ts';
import { createLoopbackCertificate, removeLoopbackCertificate } from './github/loopbackCertificate.ts';
import { readGithubToken } from './github/githubRouting.ts';
import { checkAppUrl, defaultAppAddressDeps } from './apps/appAddress.ts';
import type { AllowedPrivateHost } from './apps/appAddress.ts';
import { ConnectedAppStore } from './store/ConnectedAppStore.ts';

interface RuntimeConnection {
    proxy?: KeyProxy;
}

validateAgentIsolation(process.env.CLOUDBOT_AGENT_USER);

const port = readServerPort(process.env);
const version = process.env.CLOUDBOT_VERSION ?? 'dev';
const dataDir = resolveDataDir();
const databaseFilePath = databasePath(dataDir);
// One database handle serves the setup access and the chat stores.
const opened = await openDatabase(databaseFilePath);
const settings = new SettingsStore(opened.db);
const access = new SetupAccess(settings);
const botStore = new BotStore(opened.db);
const messageStore = new MessageStore(opened.db);

await ensureDefaultBot(botStore);

const claudePath = process.env.CLAUDE_PATH;
const agentUser = process.env.CLOUDBOT_AGENT_USER;
const authOptions = { claudePath: claudePath ?? 'claude', ...(agentUser ? { agentUser } : {}) };
const environmentEntries = Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined
        && !entry[0].startsWith('ANTHROPIC_') && entry[0] !== 'CLAUDE_CODE_OAUTH_TOKEN');
const environment = Object.fromEntries(environmentEntries);
const connection: RuntimeConnection = {};
const runner = new SdkAgentRunner({ pathToClaudeCodeExecutable: claudePath, environment });
// The image sets CLOUDBOT_DESKTOP_COMMAND. Local development leaves it unset and has no desktop or browser tools.
const desktopCommand = buildDesktopCommand(process.env.CLOUDBOT_DESKTOP_COMMAND, agentUser);
const desktop = desktopCommand === undefined ? undefined : new DesktopSupervisor({ desktopCommand });
const browser = desktop === undefined ? undefined : new BrowserControl({ devtoolsUrl: DESKTOP_DEVTOOLS_URL });
const screen = new ScreenHolder();
const vault = new Vault(dataDir);
const botSecrets = new BotSecrets(vault);
const ruleStore = new RuleStore(opened.db);
const routineStore = new RoutineStore(opened.db);
const modelStore = new ModelStore(opened.db);
const limitStore = new LimitStore(opened.db);
const webhookStore = new WebhookStore(opened.db);
// One log for the whole process, so the bot and the owner see the same refused calls. It is kept in memory only.
const webhookRefusals = new WebhookRefusalLog();
// The delivery ids, shared by the call route and the owner routes, so a deleted webhook drops its ids.
const webhookDeliveries = new DeliveryMemory();
const watchStore = new WatchStore(opened.db);
const browserAllowStore = new BrowserAllowStore(opened.db);
const connectedAppStore = new ConnectedAppStore(opened.db);

// The hosts the owner allowed the browser to reach. Only those may be private for a connected app.
async function allowedPrivateHosts(): Promise<AllowedPrivateHost[]> {
    const records = await browserAllowStore.list();

    return records.map(record => ({ host: record.host, port: record.port }));
}
// The proxy holds the tokens of the connected servers. The bot reaches them only through it, and each request is checked again.
const appProxy = new AppProxy({
    checkUpstream: async (url) => {
        const hosts = await allowedPrivateHosts();
        const addressDeps = defaultAppAddressDeps(hosts);
        const checked = await checkAppUrl(url.href, addressDeps);

        return checked.addresses;
    },
});
const connectedApps = new ConnectedApps({ store: connectedAppStore, secrets: botSecrets, proxy: appProxy, allowedHosts: allowedPrivateHosts });
// The gate is the browser's only way out. It starts before the desktop, so Chromium never runs without it.
const browserGate = desktop === undefined
    ? undefined
    : new BrowserGate({
            isAllowed: (host, port) => browserAllowStore.isAllowed(host, port),
        });

// Integrations run as their own user, which cannot read the vault, the workspaces or the bot's shell. They need the
// agent user too, so their workspace path is the one the chat uses. Otherwise they stay off.
function readIntegrationUser(agentUserName: string | undefined, integrationUserName: string | undefined): string | undefined {
    if (integrationUserName === undefined) {
        console.log('Integrations stay off: CLOUDBOT_INTEGRATION_USER is not set.');

        return undefined;
    }

    if (agentUserName === undefined) {
        console.log('Integrations stay off: CLOUDBOT_AGENT_USER is not set, so the workspace path would not match the chat.');

        return undefined;
    }

    return integrationUserName;
}

const integrationUser = readIntegrationUser(agentUser, process.env.CLOUDBOT_INTEGRATION_USER);
const integrationService = integrationUser === undefined
    ? undefined
    : new IntegrationService({
            store: new IntegrationStore(opened.db),
            secrets: botSecrets,
            workspaceFor: botId => agentWorkspacePath(botId, AGENT_WORKSPACE_ROOT),
            run: (request) => {
                const wrapped = asIntegrationUser(integrationUser, request);

                return runIntegrationProcess(wrapped);
            },
            cleanup: () => runCleanup(integrationUser),
        });
// The review model has no tools, so it runs as the server user. The environment object is shared, so a change of sign-in reaches it.
const askReviewModel = createClaudeReviewModel({
    pathToClaudeCodeExecutable: claudePath, environment, workingDirectory: dataDir,
});
const toolCallReviewer = createToolCallReviewer({
    askModel: askReviewModel,
    readContext: createReviewContextReader({ ruleStore, messageStore, modelStore }),
    // The card of an integration change shows its script, so the owner approves what runs. Set only with integrations.
    describeChange: integrationService === undefined ? undefined : (botId, mode, input) => integrationService.describeChange(botId, mode, input),
    // The review cost counts against the spending limit of the turn that asked for the review.
    reportCost: (botId, costUsd, turnSignal) => {
        chatService.recordReviewCost(botId, costUsd, turnSignal);
    },
});
// The bot's git and gh reach GitHub only through this proxy. It needs openssl for its loopback certificate, so without it GitHub routing is off.
const githubCertificate = await createLoopbackCertificate()
    .catch(() => {
        console.error('GitHub routing is off, because openssl could not make the loopback certificate.');

        return undefined;
    });
// The type is written out, since chatService is defined after this and TypeScript cannot infer the closures' types otherwise.
const githubProxy: GithubProxy | undefined = githubCertificate === undefined
    ? undefined
    : new GithubProxy({
            readToken: botId => readGithubToken(botSecrets, botId),
            // The approval card is answered in the chat. chatService is set below, before any turn can run.
            approve: (botId, summary, detail) => chatService.requestOwnerApproval(botId, summary, detail),
            key: githubCertificate.key,
            cert: githubCertificate.cert,
            caFile: githubCertificate.caFile,
            bundleFile: githubCertificate.bundleFile,
        });
const chatService: ChatService = new ChatService({
    botStore, messageStore, runner, dataDir, agentUser: process.env.CLOUDBOT_AGENT_USER, browser, botSecrets, ruleStore, routineStore, modelStore, limitStore, screen,
    webhookStore,
    watchStore,
    connectedApps,
    integrationService,
    browserAllowStore,
    webhookBaseUrl: readPublicBaseUrl(process.env),
    webhookRefusals,
    webhookDeliveries,
    toolCallReviewer,
    ...(githubProxy === undefined ? {} : { githubEnvironment: botId => githubProxy.environmentFor(botId), forgetGithub: botId => githubProxy.forget(botId) }),
});
const bots = await botStore.list();
const firstBot = bots[0];

if (firstBot === undefined) {
    throw new Error('The default bot is missing.');
}

const setup = new SetupConversation({
    botId: firstBot.id, chat: chatService, messages: messageStore, settings, vault,
    startLogin: () => startClaudeLogin(authOptions),
    authStatus: () => getClaudeAuthStatus(authOptions),
    checkKey: checkApiKey,
    connect: async (mode) => {
        if (mode === 'apiKey') {
            connection.proxy ??= await startKeyProxy({ vault, secretName: API_KEY_NAME });
            environment.ANTHROPIC_BASE_URL = connection.proxy.url;
            environment.ANTHROPIC_API_KEY = 'cloudbot-key-proxy';
        } else {
            delete environment.ANTHROPIC_BASE_URL;
            delete environment.ANTHROPIC_API_KEY;
        }
    },
});

chatService.setSetup(setup);
await appProxy.start();
await connectedApps.start();
await browserGate?.start();
desktop?.start();

const routineScheduler = new RoutineScheduler({
    routineStore,
    sendMessage: (botId, text) => chatService.sendMessage(botId, text, 'routine'),
    isReady: () => setup.isDone(),
});

// Page watches wake the bot through the same routine turns, so they use the routines model and effort.
const watchScheduler = new WatchScheduler({
    watchStore,
    fetchPage: url => fetchWatchedPage(url),
    sendMessage: (botId, text) => chatService.sendMessage(botId, text, 'routine'),
    isReady: () => setup.isDone(),
});

// Queued messages and usage limit waits from the last run continue before the first request.
await chatService.resumeQueue();
routineScheduler.start();
watchScheduler.start();

function cleanUploads(): void {
    chatService.cleanUploads()
        .catch(() => {
            console.error('Could not clean up old uploads.');
        });
}

// Old uploads are removed on start and once a day.
cleanUploads();

const cleanupTimer = setInterval(cleanUploads, CLEANUP_INTERVAL_MS);

cleanupTimer.unref();

const app = createApp({ version, access, chatService, ruleStore, routineStore, modelStore, limitStore, webhookStore, webhookRefusals, webhookDeliveries, watchStore, connectedApps, isReady: () => setup.isDone(), screen });

// With no session yet there is no owner, so a new setup link is printed on every start.
// Only the hash of the code is stored, so a link lost in an earlier run is replaced, not reprinted.
const hasSession = await access.hasSession();

if (!hasSession) {
    const setupCode = await access.issueSetupCode();
    const setupLink = buildSetupLink(setupCode, process.env);

    console.log(`Open this link to make this browser the owner: ${setupLink}`);
}

const server = serve({ fetch: app.fetch, port }, (address) => {
    console.log(`CloudBot is listening on http://localhost:${String(address.port)}`);
    void setup.start()
        .catch(() => {
            console.error('Could not start Claude setup.');
        });
});

// The live view needs the desktop. Local development has none.
if (desktop !== undefined) {
    attachVncProxy({ server: server as Server, access, screen });
}

function shutdown(): void {
    clearInterval(cleanupTimer);
    routineScheduler.stop();
    desktop?.stop();
    void browserGate?.close();
    void appProxy.close();
    void githubProxy?.close();
    // The certificate's public folder is removed on exit. Its key was only on disk in a private folder while openssl ran.
    if (githubCertificate !== undefined) {
        void removeLoopbackCertificate(githubCertificate);
    }
    setup.close();
    server.close();
    (server as Server).closeAllConnections();
    void connection.proxy?.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.once('close', () => {
    setup.close();
});
