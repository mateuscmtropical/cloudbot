const AGENT_PATH = '/usr/local/bin:/usr/bin:/bin';
const DUMMY_API_KEY = 'cloudbot-key-proxy';

function validateAgentUser(user: string): void {
    if (!/^[a-z_][a-z0-9_-]*$/.test(user)) {
        throw new Error('Invalid agent user.');
    }
}

// The extra variables come last. sudo keeps only the names listed in its env_keep, so a new name needs one there too.
function buildAgentEnvironment(user: string, environment?: Record<string, string>, extraEnvironment?: Record<string, string>): Record<string, string> {
    const proxyUrl = environment?.ANTHROPIC_BASE_URL;
    const proxyEnvironment = proxyUrl
        ? { ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_API_KEY: DUMMY_API_KEY }
        : {};

    // The image ships the CLI, so it never updates itself. The updater would write to the bot's home.
    return { HOME: `/home/${user}`, PATH: AGENT_PATH, DISABLE_AUTOUPDATER: '1', ...proxyEnvironment, ...extraEnvironment };
}

export { buildAgentEnvironment, validateAgentUser };
