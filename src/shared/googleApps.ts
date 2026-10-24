// The Google Workspace apps that connect through Google's own remote MCP servers. They are fixed: the sign-in
// endpoints are known in advance, since the servers do not publish working discovery, and the owner brings
// a Google Cloud OAuth client of their own. Shared by the server, which signs in, and the app catalog.

interface GoogleApp {
    serverName: string;
    displayName: string;
    description: string;
    url: string;
    scopes: string[];
}

const GOOGLE_SCOPE_BASE = 'https://www.googleapis.com/auth/';

function googleScopes(names: string[]): string[] {
    return names.map(name => `${GOOGLE_SCOPE_BASE}${name}`);
}

const GOOGLE_APPS: GoogleApp[] = [
    {
        serverName: 'google-gmail',
        displayName: 'Gmail',
        description: 'Search, read, and draft your email.',
        url: 'https://gmailmcp.googleapis.com/mcp/v1',
        scopes: googleScopes(['gmail.readonly', 'gmail.compose']),
    },
    {
        serverName: 'google-calendar',
        displayName: 'Google Calendar',
        description: 'Check your schedule and manage events.',
        url: 'https://calendarmcp.googleapis.com/mcp/v1',
        scopes: googleScopes(['calendar.calendarlist.readonly', 'calendar.events.freebusy', 'calendar.events.readonly', 'calendar.events']),
    },
    {
        serverName: 'google-drive',
        displayName: 'Google Drive',
        description: 'Search and read files in your Drive.',
        url: 'https://drivemcp.googleapis.com/mcp/v1',
        scopes: googleScopes(['drive.readonly', 'drive.file']),
    },
    {
        serverName: 'google-docs',
        displayName: 'Google Docs',
        description: 'Read and edit your Google documents.',
        url: 'https://docsmcp.googleapis.com/mcp/v1',
        scopes: googleScopes(['drive.readonly', 'drive.file', 'documents.readonly', 'documents']),
    },
    {
        serverName: 'google-sheets',
        displayName: 'Google Sheets',
        description: 'Read and edit your spreadsheets.',
        url: 'https://sheetsmcp.googleapis.com/mcp/v1',
        scopes: googleScopes(['drive.readonly', 'drive.file', 'spreadsheets.readonly', 'spreadsheets']),
    },
];

// One sign-in connects all five apps. The group asks for every scope of its members once, deduplicated, and the
// server then keeps one connection for each member. The group has no server of its own, so its address is the
// one of its first member. Together with the name, it is what tells the group from a custom app.
interface GoogleGroup {
    serverName: string;
    displayName: string;
    description: string;
    url: string;
    scopes: string[];
    members: GoogleApp[];
}

const GOOGLE_GROUP_SCOPES = GOOGLE_APPS.flatMap(app => app.scopes);

const GOOGLE_GROUP: GoogleGroup = {
    serverName: 'google',
    displayName: 'Google',
    description: 'Gmail, Calendar, Drive, Docs and Sheets in one sign-in.',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    scopes: [...new Set(GOOGLE_GROUP_SCOPES)],
    members: GOOGLE_APPS,
};

function findGoogleGroup(serverName: string, url: string): GoogleGroup | undefined {
    return serverName === GOOGLE_GROUP.serverName && url === GOOGLE_GROUP.url ? GOOGLE_GROUP : undefined;
}

// Both the name and the address must match, so a custom app that only borrows the name is not treated as Google.
function findGoogleApp(serverName: string, url: string): GoogleApp | undefined {
    return GOOGLE_APPS.find(app => app.serverName === serverName && app.url === url);
}

export { GOOGLE_APPS, GOOGLE_GROUP, findGoogleApp, findGoogleGroup };
export type { GoogleApp, GoogleGroup };
