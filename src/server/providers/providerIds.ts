// The AI providers a bot can run on. Claude covers both the subscription and the API key, since one Claude connection serves all bots.
const PROVIDER_IDS = ['claude', 'chatgpt'] as const;

type ProviderId = typeof PROVIDER_IDS[number];

const PROVIDER_LABELS: Record<ProviderId, string> = {
    claude: 'Claude',
    chatgpt: 'ChatGPT',
};

function isProviderId(value: string): value is ProviderId {
    return (PROVIDER_IDS as readonly string[]).includes(value);
}

export { PROVIDER_IDS, PROVIDER_LABELS, isProviderId };
export type { ProviderId };
