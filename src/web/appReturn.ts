// An app's sign-in page sends the owner back to the address /?apps=connected&app=notion. The panel then opens by itself.
// The sign-in opens in a new window. That window tells the first one on this channel, then closes itself.

const APP_SIGN_IN_CHANNEL = 'cloudbot-app-sign-in';

interface AppReturn {
    appName: string | undefined;
    outcome: 'connected' | 'failed';
}

function readAppReturn(search: string): AppReturn | undefined {
    const parameters = new URLSearchParams(search);
    const outcome = parameters.get('apps');

    if (outcome !== 'connected' && outcome !== 'failed') {
        return undefined;
    }

    return { appName: parameters.get('app') ?? undefined, outcome };
}

function describeAppReturn(appReturn: AppReturn): string {
    const appLabel = appReturn.appName === undefined
        ? 'The app'
        : `${appReturn.appName.charAt(0)
            .toUpperCase()}${appReturn.appName.slice(1)}`;

    return appReturn.outcome === 'connected' ? `${appLabel} is connected.` : `${appLabel} was not connected. Try again.`;
}

function announceAppReturn(search: string): void {
    if (typeof BroadcastChannel === 'undefined') {
        return;
    }

    try {
        const parameters = new URLSearchParams(search);
        const channel = new BroadcastChannel(APP_SIGN_IN_CHANNEL);

        channel.postMessage({ apps: parameters.get('apps'), app: parameters.get('app'), bot: parameters.get('bot') });
        channel.close();
    } catch {
        // The page still shows the notice, so the owner loses nothing.
    }
}

// Reads a channel message back into the same shape as the address.
function readAppReturnMessage(data: unknown): AppReturn | undefined {
    if (typeof data !== 'object' || data === null) {
        return undefined;
    }

    const message = data as Record<string, unknown>;
    const parameters = new URLSearchParams();

    ['apps', 'app'].forEach((key) => {
        const value = message[key];

        if (typeof value === 'string') {
            parameters.set(key, value);
        }
    });

    const search = parameters.toString();

    return readAppReturn(search);
}

export { announceAppReturn, APP_SIGN_IN_CHANNEL, describeAppReturn, readAppReturn, readAppReturnMessage };

export type { AppReturn };
