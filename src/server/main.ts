import { serve } from '@hono/node-server';

import { SetupAccess } from './access/SetupAccess.ts';
import { buildSetupLink, readServerPort } from './access/setupLinkUrl.ts';
import { createApp } from './createApp.ts';
import { openDatabase } from './store/openDatabase.ts';
import { databasePath, resolveDataDir } from './store/resolveDataDir.ts';
import { SettingsStore } from './store/SettingsStore.ts';

const port = readServerPort(process.env);
const version = process.env.CLOUDBOT_VERSION ?? 'dev';
const dataDirectory = resolveDataDir();
const databaseFilePath = databasePath(dataDirectory);
const opened = await openDatabase(databaseFilePath);
const access = new SetupAccess(new SettingsStore(opened.db));
const app = createApp({ version, access });

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
