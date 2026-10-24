import { checkAppUrl, defaultAppAddressDeps } from './appAddress.ts';
import type { AllowedPrivateHost, AppAddressDeps } from './appAddress.ts';
import { pinnedFetch } from './pinnedFetch.ts';
import type { FetchFunction } from './probeAppServer.ts';

// A fetch for the sign-in requests of a connected server. Each address named by the server is checked like a server
// address, and the request goes only to the addresses that were checked, so a server cannot point the sign-in at a private host.
function createGuardedFetch(
    allowedHosts: () => Promise<AllowedPrivateHost[]>,
    addressDeps?: ((hosts: AllowedPrivateHost[]) => AppAddressDeps),
): FetchFunction {
    return async (target, init) => {
        const hosts = await allowedHosts();
        const deps = addressDeps === undefined ? defaultAppAddressDeps(hosts) : addressDeps(hosts);
        const checked = await checkAppUrl(target, deps);

        return pinnedFetch(checked.url, init, checked.addresses);
    };
}

export { createGuardedFetch };
