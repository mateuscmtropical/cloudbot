import { serve } from '@hono/node-server';
import { validateAgentIsolation } from './agent/buildClaudeCommand.ts';

import { SdkAgentRunner } from './agent/SdkAgentRunner.ts';
import { SetupAccess } from './access/SetupAccess.ts';
import { buildSetupLink, readServerPort } from './access/setupLinkUrl.ts';
import { ChatService } from './chat/ChatService.ts';
import { createApp } from './createApp.ts';
import { BotStore } from './store/BotStore.ts';
import { MessageStore } from './store/MessageStore.ts';
import { ensureDefaultBot } from './store/ensureDefaultBot.ts';
import { openDatabase } from './store/openDatabase.ts';
import { databasePath, resolveDataDir } from './store/resolveDataDir.ts';
import { SettingsStore } from './store/SettingsStore.ts';

validateAgentIsolation(process.env.CLOUDBOT_AGENT_USER);

const port = readServerPort(process.env);
const version = process.env.CLOUDBOT_VERSION ?? 'dev';
const dataDir = resolveDataDir();
const databaseFilePath = databasePath(dataDir);
// One database handle serves the setup access and the chat stores.
const opened = await openDatabase(databaseFilePath);
const access = new SetupAccess(new SettingsStore(opened.db));
const botStore = new BotStore(opened.db);
const messageStore = new MessageStore(opened.db);

await ensureDefaultBot(botStore);

const claudePath = process.env.CLAUDE_PATH;
// The agent inherits this process environment for now. Later the server passes a minimal one.
const runner = new SdkAgentRunner({ pathToClaudeCodeExecutable: claudePath });
const chatService = new ChatService({ botStore, messageStore, runner, dataDir, agentUser: process.env.CLOUDBOT_AGENT_USER });
const app = createApp({ version, access, chatService });

// With no session yet there is no owner, so a new setup link is printed on every start.
// Only the hash of the code is stored, so a link lost in an earlier run is replaced, not reprinted.
const hasSession = await access.hasSession();

if (!hasSession) {
    const setupCode = await access.issueSetupCode();
    const setupLink = buildSetupLink(setupCode, process.env);

    console.log(`Open this link to make this browser the owner: ${setupLink}`);
}

serve({ fetch: app.fetch, port }, (address) => {
    console.log(`CloudBot is listening on http://localhost:${String(address.port)}`);
});
