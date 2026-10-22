import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Bot ids are UUIDs. Anything else could leave the codex folder, so it is refused.
const BOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODEX_HOME_MODE = 0o700;

// Each bot gets its own CODEX_HOME in the data folder, owned by CloudBot. Codex keeps its sign-in and config there, so
// two bots never share one, and nothing comes from a user's ~/.codex.
function codexHomeFor(dataDir: string, botId: string): string {
    if (!BOT_ID_PATTERN.test(botId)) {
        throw new Error('The bot id is not valid.');
    }

    return join(dataDir, 'codex', botId);
}

// codex app-server exits at start when CODEX_HOME does not exist (codex-cli 0.163.0), so the folder is made first.
// chmod, not only the mkdir mode: the umask and an existing folder would otherwise change the mode.
async function prepareCodexHome(dataDir: string, botId: string): Promise<string> {
    const home = codexHomeFor(dataDir, botId);

    await mkdir(home, { recursive: true, mode: CODEX_HOME_MODE });
    await chmod(home, CODEX_HOME_MODE);

    return home;
}

export { codexHomeFor, prepareCodexHome };
