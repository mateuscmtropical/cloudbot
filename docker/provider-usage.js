// Reads the plan usage of one provider with the call its own CLI makes and the sign-in that CLI saved in this home.
// It runs as the bot user, so the sign-in never reaches the server. It prints only the body of the answer, which the
// server parses, and ends with 0 when the call worked. These are the CLI's own calls and they may change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME ?? '/tmp';
const TIMEOUT_MS = 10000;
// The Kimi token is refreshed only by Kimi Code, whose refresh rotates the token. A token this close to its end is not used.
const KIMI_TOKEN_MARGIN_SECONDS = 30;

function readJsonFile(file) {
    const text = readFileSync(file, 'utf8');

    return JSON.parse(text);
}

// The Copilot CLI keeps its GitHub sign-in in the config file when the keychain is not there, as it does without a desktop.
// The file has comment lines. The call is the one of the CLI, see `copilot_internal/user` in its app.js.
function copilotRequest() {
    const file = join(HOME, '.copilot', 'config.json');
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n')
        .filter(line => !line.trim()
            .startsWith('//'));
    const json = lines.join('\n');
    const config = JSON.parse(json);
    const tokens = Object.values(config.copilot_tokens ?? {});
    const token = tokens.find(value => typeof value === 'string' && value.trim() !== '');
    const host = config.lastLoggedInUser?.host ?? 'https://github.com';

    if (token === undefined || host !== 'https://github.com') {
        throw new Error('No GitHub sign-in.');
    }

    return { url: 'https://api.github.com/copilot_internal/user', token };
}

// Kimi Code keeps its sign-in in credentials/kimi-code.json. The call is its `/usage` screen, see managed-usage.
function kimiRequest() {
    const home = process.env.KIMI_CODE_HOME ?? join(HOME, '.kimi-code');
    const file = join(home, 'credentials', 'kimi-code.json');
    const credentials = readJsonFile(file);
    const isFresh = typeof credentials.expires_at === 'number' && credentials.expires_at > Date.now() / 1000 + KIMI_TOKEN_MARGIN_SECONDS;

    if (typeof credentials.access_token !== 'string' || credentials.access_token === '' || !isFresh) {
        throw new Error('No fresh Kimi sign-in.');
    }

    return { url: 'https://api.kimi.com/coding/v1/usages', token: credentials.access_token };
}

const REQUESTS = { copilot: copilotRequest, kimi: kimiRequest };
const buildRequest = REQUESTS[process.argv[2]];

if (buildRequest === undefined) {
    process.exit(2);
}

try {
    const { url, token } = buildRequest();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });

    if (!response.ok) {
        process.exit(1);
    }

    const body = await response.text();

    process.stdout.write(body);
} catch {
    process.exit(1);
}
