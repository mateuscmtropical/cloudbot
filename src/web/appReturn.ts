// An app's sign-in page sends the owner back to the address /?apps=connected&app=notion. The panel then opens by itself.

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

export { describeAppReturn, readAppReturn };
export type { AppReturn };
