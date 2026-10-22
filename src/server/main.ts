import type { Server } from 'node:http';
import { chmodSync, mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { filterOwnerEnvironment, localClaudeConfigDir, validateAgentIsolation } from './agent/buildClaudeCommand.ts';

import { CLEANUP_INTERVAL_MS } from './attachments/cleanUploads.ts';
import { ClaudeCliEngine } from './agent/ClaudeCliEngine.ts';
import { PROFILE_SERVER_NAME } from './agent/createProfileToolServer.ts';
import { AGENT_TURN_ROOT, startLoopbackToolServer } from './agent/createLoopbackToolServer.ts';
import { SetupAccess } from './access/SetupAccess.ts';
import { buildSetupLink, readPublicBaseUrl, readServerHost, readServerPort } from './access/setupLinkUrl.ts';
import { createClaudeReviewModel } from './approvals/createClaudeReviewModel.ts';
import { createReviewContextReader } from './approvals/createReviewContextReader.ts';
import { createToolCallReviewer } from './approvals/createToolCallReviewer.ts';
import { ChatService } from './chat/ChatService.ts';
import { describeRuleChange } from './rules/describeRuleChange.ts';
import { describeLimitChange } from './limits/createLimitTools.ts';
import { createApp } from './createApp.ts';
import { ScreenHolder } from './desktop/ScreenHolder.ts';
import { attachVncProxy } from './desktop/attachVncProxy.ts';
import { attachScreencast } from './desktop/attachScreencast.ts';
import { buildLocalBrowserCommand, buildLocalBrowserTools, createLocalBrowserSpawn, defaultLocalBrowserEnvironment, localBrowserProfileDir, localGatePortFor, planLocalBrowser, saveLocalGatePort, startPlannedGate, verifyLocalBrowserGate } from './desktop/localBrowser.ts';
import { BrowserGate } from './desktop/BrowserGate.ts';
import { DesktopSupervisor, buildDesktopCommand } from './desktop/DesktopSupervisor.ts';
import { BotStore } from './store/BotStore.ts';
import { ChannelStore } from './store/ChannelStore.ts';
import { BrowserAllowStore } from './store/BrowserAllowStore.ts';
import { MessageStore } from './store/MessageStore.ts';
import { RoutineScheduler } from './routines/RoutineScheduler.ts';
import { RoutineStore } from './store/RoutineStore.ts';
import { TaskStore } from './store/TaskStore.ts';
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
import { signOutClaude } from './claudeAuth/signOutClaude.ts';
import { BotSecrets } from './secrets/BotSecrets.ts';
import { Vault } from './vault/Vault.ts';
import { startKeyProxy } from './vault/KeyProxy.ts';
import type { KeyProxy } from './vault/KeyProxy.ts';
import { AppProxy } from './apps/AppProxy.ts';
import { ConnectedApps } from './apps/ConnectedApps.ts';
import { GithubProxy } from './github/GithubProxy.ts';
import { createLoopbackCertificate, removeLoopbackCertificate } from './github/loopbackCertificate.ts';
import { readGithubToken } from './github/githubRouting.ts';
import { TemplateGallery, readGalleryRepo } from './bots/templateGallery.ts';
import { createDefaultGalleryTransport } from './bots/galleryTransport.ts';
import { checkAppUrl, defaultAppAddressDeps } from './apps/appAddress.ts';
import type { AllowedPrivateHost } from './apps/appAddress.ts';
import { ConnectedAppStore } from './store/ConnectedAppStore.ts';
import { PushSubscriptionStore } from './store/PushSubscriptionStore.ts';
import { createPushSender } from './push/createPushSender.ts';
import { loadOrCreateVapidKeys } from './push/loadVapidKeys.ts';
import { PushNotifier } from './push/PushNotifier.ts';
import { readPushSubject } from './push/readPushSubject.ts';

interface RuntimeConnection {
    proxy?: KeyProxy;
}

validateAgentIsolation(process.env.CLOUDBOT_AGENT_USER);

const port = readServerPort(process.env);
const host = readServerHost(process.env);
const version = process.env.CLOUDBOT_VERSION ?? 'dev';
const dataDir = resolveDataDir();
const databaseFilePath = databasePath(dataDir);
// One database handle serves the setup access and the chat stores.
const opened = await openDatabase(databaseFilePath);
const settings = new SettingsStore(opened.db);
const access = new SetupAccess(settings);
const botStore = new BotStore(opened.db);
const channelStore = new ChannelStore(opened.db);
const messageStore = new MessageStore(opened.db);

await ensureDefaultBot(botStore);

const claudePath = process.env.CLAUDE_PATH;
const agentUser = process.env.CLOUDBOT_AGENT_USER;

// Without an agent user the bot runs as the owner's own account, so the owner should know it at start.
if (!agentUser) {
    console.warn('Local mode: the bot runs as you, on this computer. It can read your files and run commands with your account. Use Docker or CLOUDBOT_AGENT_USER to keep it apart.');
}

// Local mode keeps CloudBot's CLI login in its own folder under the data dir, never in the owner's ~/.claude.
// Docker already runs the CLI as the bot user, whose home is separate, so it keeps that location.
const claudeConfigDir = agentUser ? undefined : localClaudeConfigDir(dataDir);

if (claudeConfigDir !== undefined) {
    mkdirSync(claudeConfigDir, { recursive: true, mode: 0o700 });
    // The mode of mkdirSync applies only when the folder is created, so an existing folder is tightened here.
    chmodSync(claudeConfigDir, 0o700);
}

const authOptions = {
    claudePath: claudePath ?? 'claude',
    ...(agentUser ? { agentUser } : {}),
    ...(claudeConfigDir === undefined ? {} : { configDir: claudeConfigDir }),
};
const environment = filterOwnerEnvironment(process.env);

if (claudeConfigDir !== undefined) {
    environment.CLAUDE_CONFIG_DIR = claudeConfigDir;
}
const connection: RuntimeConnection = {};
// The CLI reaches the bot's tools and the approval hook through this loopback server. Docker keeps the turn folders under a
// root the bot user can read, see docker/Dockerfile. Local mode uses the temp folder.
const loopback = await startLoopbackToolServer(PROFILE_SERVER_NAME, {
    turnRoot: agentUser ? AGENT_TURN_ROOT : undefined,
    agentReadable: agentUser !== undefined,
});
const runner = new ClaudeCliEngine({ loopback, pathToClaudeCodeExecutable: claudePath, environment });
// The image sets CLOUDBOT_DESKTOP_COMMAND, and its desktop starts Chromium. Without it, local runs start an installed
// Chrome, Chromium or Edge with its own profile, and the browser tools stay off when none is found.
const desktopCommand = buildDesktopCommand(process.env.CLOUDBOT_DESKTOP_COMMAND, agentUser);
const desktop = desktopCommand === undefined ? undefined : new DesktopSupervisor({ desktopCommand });
const localBrowserEnvironment = defaultLocalBrowserEnvironment();
const localProfileDir = localBrowserProfileDir(dataDir);
// The plan decides the desktop, no browser, a new local browser or a reused one. It logs why a browser stays off.
const localPlan = await planLocalBrowser({
    hasDesktop: desktop !== undefined,
    hasAgentUser: agentUser !== undefined,
    environment: localBrowserEnvironment,
    profileDir: localProfileDir,
});
const localTools = buildLocalBrowserTools(localPlan, localProfileDir);
const browser = localTools.browser;
// Why the setup chat says the bot has no browser. With an agent user nothing is said, since the log says why.
const noBrowserReason = localTools.noBrowserReason;
const screen = new ScreenHolder();
const vault = new Vault(dataDir);
const botSecrets = new BotSecrets(vault);
const ruleStore = new RuleStore(opened.db);
const routineStore = new RoutineStore(opened.db);
const taskStore = new TaskStore(opened.db);
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

// The gate is the browser's only way out. It starts before the browser, so Chromium never runs without it.
function createBrowserGate(gatePort: number | undefined): BrowserGate {
    return new BrowserGate({
        ...(gatePort === undefined ? {} : { port: gatePort }),
        isAllowed: (host, allowedPort) => browserAllowStore.isAllowed(host, allowedPort),
    });
}

const localGatePort = localGatePortFor(localPlan);
const browserGate = browser === undefined
    ? undefined
    : await startPlannedGate(createBrowserGate, localGatePort, localPlan.kind);

// A reused browser whose gate port is taken has no gate, so its tools stay off, and the setup chat says it is left open.
const isReusedGateBusy = browser !== undefined && browserGate === undefined;

if (browser !== undefined && isReusedGateBusy) {
    browser.disable('The browser tools are off, because the gate port of the browser left open from the last run is taken.');
}

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
    readContext: createReviewContextReader({ ruleStore, messageStore, modelStore, channelStore }),
    // The card of an integration change shows its script, so the owner approves what runs. Set only with integrations.
    describeChange: integrationService === undefined ? undefined : (botId, mode, input) => integrationService.describeChange(botId, mode, input),
    // The rule card and the bot delete check read the stores and the chat service, which is defined below. The calls happen later, in a turn.
    describeRuleChange: (botId, input) => describeRuleChange(ruleStore, botId, input),
    describeLimitChange: (botId, input) => describeLimitChange(limitStore, botId, input),
    describeBotDelete: botId => chatService.describeBotDelete(botId),
    describeBotImport: (botId, input) => chatService.describeBotImport(botId, input),
    describeGalleryInstall: (botId, input) => chatService.describeGalleryInstall(botId, input),
    describeGalleryShare: botId => chatService.describeGalleryShare(botId),
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
// Push notifications. The key is made once in the data folder and never leaves the server. Only its public half goes to the browser.
const vapidKeys = loadOrCreateVapidKeys(dataDir);
const pushSubscriptionStore = new PushSubscriptionStore(opened.db);
const pushNotifier = new PushNotifier({
    store: pushSubscriptionStore,
    keys: vapidKeys,
    send: createPushSender(),
    subject: readPushSubject(process.env),
});
// The public gallery of templates. CLOUDBOT_GALLERY_REPO points it at another repository, such as a fork.
const templateGallery = new TemplateGallery({ repo: readGalleryRepo(process.env.CLOUDBOT_GALLERY_REPO), transport: createDefaultGalleryTransport() });
const chatService: ChatService = new ChatService({
    notifyOwner: notice => pushNotifier.notify(notice),
    botStore, channelStore, messageStore, runner, dataDir, agentUser: process.env.CLOUDBOT_AGENT_USER, claudeConfigDir, browser, botSecrets, ruleStore, routineStore, taskStore, modelStore, limitStore, screen,
    webhookStore,
    templateGallery,
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
    // Local sign-out is refused on macOS, so setup does not offer it there.
    ...(!agentUser && process.platform === 'darwin' ? {} : { signOut: () => signOutClaude(authOptions) }),
    localMode: !agentUser,
    noBrowser: isReusedGateBusy ? 'leftover' : noBrowserReason,
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

// The browser starts after the gate listens, so it gets the gate's real port. Only a new local browser is started here.
const localBrowser = localPlan.kind === 'start' && browserGate !== undefined
    ? new DesktopSupervisor({
            desktopCommand: buildLocalBrowserCommand(localPlan.browserPath, { profileDir: localProfileDir, gatePort: browserGate.listeningPort }),
            spawnFunction: createLocalBrowserSpawn(localProfileDir, process.env),
        })
    : undefined;

if (browserGate !== undefined && desktop === undefined) {
    saveLocalGatePort(localProfileDir, browserGate.listeningPort);
}

desktop?.start();
localBrowser?.start();

// A private address must fail at the gate. The browser tools stay off until it does, also for a reused browser.
// The check keeps retrying until it passes, and stops when the server shuts down.
const gateController = new AbortController();

if (localTools.gateProbe !== undefined && browser !== undefined && browserGate !== undefined) {
    void verifyLocalBrowserGate(localTools.gateProbe, browser, { signal: gateController.signal });
}

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

const app = createApp({ push: { store: pushSubscriptionStore, publicKey: pushNotifier.publicKey }, version, publicUrl: process.env.CLOUDBOT_PUBLIC_URL, access, chatService, channelStore, botStore, ruleStore, routineStore, modelStore, limitStore, webhookStore, webhookRefusals, webhookDeliveries, watchStore, connectedApps, isReady: () => setup.isDone(), screen, screenView: desktop === undefined ? 'screencast' : 'vnc' });

// With no session yet there is no owner, so a new setup link is printed on every start.
// Only the hash of the code is stored, so a link lost in an earlier run is replaced, not reprinted.
const hasSession = await access.hasSession();

if (!hasSession) {
    const setupCode = await access.issueSetupCode();
    const setupLink = buildSetupLink(setupCode, process.env);

    console.log(`Open this link to make this browser the owner: ${setupLink}`);
}

const server = serve({ fetch: app.fetch, port, hostname: host }, (address) => {
    // The address the socket really got, so a HOST that was changed on purpose shows in the log.
    const listenHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;

    console.log(`CloudBot is listening on http://${listenHost}:${String(address.port)}`);
    void setup.start()
        .catch(() => {
            console.error('Could not start Claude setup.');
        });
});

// The live view is VNC on the desktop. Local runs show the browser's own frames instead.
// The owner's public address may differ from the host the panel is opened on, so its host is allowed too.
const publicUrl = process.env.CLOUDBOT_PUBLIC_URL;

if (desktop !== undefined) {
    attachVncProxy({ server: server as Server, access, screen, publicUrl });
} else if (browser !== undefined) {
    attachScreencast({ server: server as Server, access, browser, screen, publicUrl });
}

function shutdown(): void {
    clearInterval(cleanupTimer);
    routineScheduler.stop();
    desktop?.stop();
    localBrowser?.stop();
    gateController.abort();
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
    // The CLI processes stop first, so no tool call reaches the loopback server after it closes.
    // The loopback closes even when a stop fails, so the port is never left open.
    void runner.close()
        .catch((error: unknown) => {
            console.error('Could not stop the CLI processes:', error);
        })
        .then(() => loopback.close())
        .catch((error: unknown) => {
            console.error('Could not close the loopback server:', error);
        });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.once('close', () => {
    setup.close();
});
