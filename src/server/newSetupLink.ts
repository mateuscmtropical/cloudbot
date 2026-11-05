import { readServerConfig } from './config.ts';
import { SetupAccess } from './access/SetupAccess.ts';
import { buildSetupLink } from './access/setupLinkUrl.ts';
import { openDatabase } from './store/openDatabase.ts';
import { databasePath } from './store/resolveDataDir.ts';
import { SettingsStore } from './store/SettingsStore.ts';

// Run with `pnpm setup-link`. The running server reads the code from the database
// on every request, so the new code works without a restart.
const dataDirectory = readServerConfig(process.env).dataDir;
const databaseFilePath = databasePath(dataDirectory);
const opened = await openDatabase(databaseFilePath);
const access = new SetupAccess(new SettingsStore(opened.db));
const setupCode = await access.issueSetupCode();

opened.close();

const setupLink = buildSetupLink(setupCode, process.env);

console.log(`New setup link. Opening it ends every existing session: ${setupLink}`);
