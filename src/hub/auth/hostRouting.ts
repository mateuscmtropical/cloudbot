import { checkPersonName } from '../../shared/peopleTypes.ts';

interface HostRoute {
    hostname: string;
    isApex: boolean;
    name?: string;
}

function readHostRoute(hostHeader: string | undefined, domain: string): HostRoute | undefined {
    if (hostHeader === undefined || hostHeader === '') {
        return undefined;
    }

    let hostname: string;

    try {
        const url = new URL(`http://${hostHeader}`);

        if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
            return undefined;
        }

        hostname = url.hostname.toLowerCase();
    } catch {
        return undefined;
    }

    const normalizedDomain = domain.toLowerCase()
        .replace(/\.$/, '');

    if (hostname === normalizedDomain) {
        return { hostname, isApex: true };
    }

    const suffix = `.${normalizedDomain}`;

    if (!hostname.endsWith(suffix)) {
        return { hostname, isApex: false };
    }

    const name = hostname.slice(0, -suffix.length);

    if (name.includes('.') || checkPersonName(name) !== undefined) {
        return { hostname, isApex: false };
    }

    return { hostname, isApex: false, name };
}

export { readHostRoute };
export type { HostRoute };
