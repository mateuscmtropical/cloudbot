import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { validateAgentIsolation } from './agent/buildClaudeCommand.ts';

import { CLEANUP_INTERVAL_MS } from './attachments/cleanUploads.ts';
import { SdkAgentRunner } from './agent/SdkAgentRunner.ts';
import { SetupAccess } from './access/SetupAccess.ts';
import { buildSetupLink, readServerPort } from './access/setupLinkUrl.ts';
import { ChatService } from './chat/ChatService.ts';
import { createApp } from './createApp.ts';
import { BrowserControl, DESKTOP_DEVTOOLS_URL } from './desktop/BrowserControl.ts';
import { DesktopSupervisor, buildDesktopCommand } from './desktop/DesktopSupervisor.ts';
import { BotStore } from './store/BotStore.ts';
import { MessageStore } from './store/MessageStore.ts';
import { ensureDefaultBot } from './store/ensureDefaultBot.ts';
import { openDatabase } from './store/openDatabase.ts';
import { databasePath, resolveDataDir } from './store/resolveDataDir.ts';
import { SettingsStore } from './store/SettingsStore.ts';
import { checkApiKey } from './setup/checkApiKey.ts';
import { SetupConversation, API_KEY_NAME } from './setup/SetupConversation.ts';
import { startClaudeLogin } from './claudeAuth/startClaudeLogin.ts';
import { getClaudeAuthStatus } from './claudeAuth/getClaudeAuthStatus.ts';
import { Vault } from './vault/Vault.ts';
import { startKeyProxy } from './vault/KeyProxy.ts';
import type { KeyProxy } from './vault/KeyProxy.ts';

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
const vault = new Vault(dataDir);
const runner = new SdkAgentRunner({ pathToClaudeCodeExecutable: claudePath, environment });
// The image sets CLOUDBOT_DESKTOP_COMMAND. Local development leaves it unset and has no desktop or browser tools.
const desktopCommand = buildDesktopCommand(process.env.CLOUDBOT_DESKTOP_COMMAND, agentUser);
const desktop = desktopCommand === undefined ? undefined : new DesktopSupervisor({ desktopCommand });
const browser = desktop === undefined ? undefined : new BrowserControl({ devtoolsUrl: DESKTOP_DEVTOOLS_URL });
const chatService = new ChatService({ botStore, messageStore, runner, dataDir, agentUser: process.env.CLOUDBOT_AGENT_USER, browser });
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
desktop?.start();

// Queued messages and usage limit waits from the last run continue before the first request.
await chatService.resumeQueue();

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

const app = createApp({ version, access, chatService });

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

function shutdown(): void {
    clearInterval(cleanupTimer);
    desktop?.stop();
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
