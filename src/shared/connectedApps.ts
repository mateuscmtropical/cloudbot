// The state of a remote MCP server the owner connected by URL.
// connected: the server answered and its tools are available to the bot.
// needs_token: the server refused without a token. The bot asks the owner for one.
// failed: the server could not be reached or did not speak MCP.
const CONNECTED_APP_STATUSES = ['connected', 'needs_token', 'failed'] as const;

type ConnectedAppStatus = (typeof CONNECTED_APP_STATUSES)[number];

interface ConnectedAppSummary {
    id: string;
    name: string;
    url: string;
    status: ConnectedAppStatus;
    toolCount: number;
    // A short reason for a failed or waiting server. It never holds a token or an address of this machine.
    problem?: string | undefined;
}

export { CONNECTED_APP_STATUSES };
export type { ConnectedAppStatus, ConnectedAppSummary };
