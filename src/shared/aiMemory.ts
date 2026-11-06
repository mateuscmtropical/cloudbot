// The long-term memory of the bots, ai-memory. The image installs its binary. The server runs it on loopback, and the hub
// gives the switch to each instance it starts, so one setting covers every person on the server.

const AI_MEMORY_ENV = 'CLOUDBOT_AI_MEMORY';
// The name of the memory server in each turn's MCP config, so its tools are named mcp__memory__<tool>.
const AI_MEMORY_SERVER_NAME = 'memory';

// Memory is on unless the variable says off. An empty value counts as on, like the image default.
function readAiMemoryEnabled(env: Record<string, string | undefined>): boolean {
    const value = (env[AI_MEMORY_ENV] ?? '').trim();

    if (value === '' || value === 'on') {
        return true;
    }

    if (value === 'off') {
        return false;
    }

    throw new Error(`${AI_MEMORY_ENV} must be on or off.`);
}

export { AI_MEMORY_ENV, AI_MEMORY_SERVER_NAME, readAiMemoryEnabled };
