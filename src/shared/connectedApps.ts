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

// Where the app sends the owner back after the sign-in page of a connected server. The hub lets this one path through
// without a session, since the browser comes back from another site and drops its strict cookie.
const APP_OAUTH_CALLBACK_PATH = '/api/apps/oauth/callback';

// The answer to starting a sign-in from the Connect apps panel.
// redirect: open the address, the server's own sign-in page.
// unsupported: the server has no sign-in page for apps, so the bot asks for a token in the chat instead.
// failed: the sign-in could not start.
type AppSignInStart
    = | { status: 'redirect'; authorizationUrl: string }
        | { status: 'unsupported' }
        | { status: 'failed'; problem: string };

export { APP_OAUTH_CALLBACK_PATH, CONNECTED_APP_STATUSES };
export type { AppSignInStart, ConnectedAppStatus, ConnectedAppSummary };
