// The AI providers a bot can run on. Each one covers its subscription and its API key, since one connection serves all bots.
const PROVIDER_IDS = ['claude', 'chatgpt', 'gemini', 'copilot', 'cursor', 'grok', 'mistral', 'qwen', 'kimi', 'opencode'] as const;

type ProviderId = typeof PROVIDER_IDS[number];

const PROVIDER_LABELS: Record<ProviderId, string> = {
    claude: 'Claude',
    chatgpt: 'ChatGPT',
    gemini: 'Gemini',
    copilot: 'GitHub Copilot',
    cursor: 'Cursor',
    grok: 'Grok',
    mistral: 'Mistral',
    qwen: 'Qwen',
    kimi: 'Kimi',
    opencode: 'opencode',
};

function isProviderId(value: string): value is ProviderId {
    return (PROVIDER_IDS as readonly string[]).includes(value);
}

export { PROVIDER_IDS, PROVIDER_LABELS, isProviderId };
export type { ProviderId };
