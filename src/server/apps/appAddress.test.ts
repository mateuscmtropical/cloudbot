import { describe, expect, it } from 'vitest';

import { AppAddressError, checkAppUrl } from './appAddress.ts';
import type { AllowedPrivateHost, AppAddressDeps } from './appAddress.ts';

function depsWith(addresses: string[], allowedHosts: AllowedPrivateHost[] = []): AppAddressDeps {
    return {
        resolve: () => Promise.resolve(addresses),
        localAddresses: ['203.0.113.9'],
        allowedHosts,
    };
}

async function refusalOf(text: string, deps: AppAddressDeps): Promise<string | undefined> {
    try {
        await checkAppUrl(text, deps);

        return undefined;
    } catch (error: unknown) {
        return error instanceof AppAddressError ? error.message : 'other error';
    }
}

describe('checkAppUrl', () => {
    it('accepts a public https address', async () => {
        const checked = await checkAppUrl('https://mcp.linear.app/mcp', depsWith(['93.184.216.34']));

        expect(checked.url.href)
            .toBe('https://mcp.linear.app/mcp');
        expect(checked.addresses)
            .toEqual(['93.184.216.34']);
    });

    it('refuses other schemes before any name is resolved', async () => {
        expect(await refusalOf('ftp://example.com/mcp', depsWith(['93.184.216.34'])))
            .toBe('Only http and https addresses can be connected.');
    });

    it('refuses a name that resolves to a private address unless the owner allowed the host', async () => {
        expect(await refusalOf('https://intranet.test/mcp', depsWith(['10.0.0.5'])))
            .toContain('private or reserved');
        expect(await checkAppUrl('https://intranet.test/mcp', depsWith(['10.0.0.5'], [{ host: 'intranet.test', port: 0 }])))
            .toMatchObject({ addresses: ['10.0.0.5'] });
    });

    it('never allows loopback, the metadata address or this machine, even when the host is allowed', async () => {
        expect(await refusalOf('https://localhost/mcp', depsWith(['127.0.0.1'], [{ host: 'localhost', port: 0 }])))
            .toContain('private or reserved');
        expect(await refusalOf('http://169.254.169.254/latest', depsWith([], [])))
            .toContain('private or reserved');
        expect(await refusalOf('https://self.test/mcp', depsWith(['203.0.113.9'], [{ host: 'self.test', port: 0 }])))
            .toContain('private or reserved');
    });

    it('refuses an address where one of the resolved addresses is private', async () => {
        expect(await refusalOf('https://mixed.test/mcp', depsWith(['93.184.216.34', '192.168.1.2'])))
            .toContain('private or reserved');
    });

    it('refuses a user name or password in the address', async () => {
        expect(await refusalOf('https://user:secret@mcp.linear.app/mcp', depsWith(['93.184.216.34'])))
            .toBe('Put the token in the secure form, not in the address.');
    });

    it('refuses a name that does not resolve', async () => {
        const deps: AppAddressDeps = {
            resolve: () => Promise.reject(new Error('no such host')),
            localAddresses: [],
            allowedHosts: [],
        };

        expect(await refusalOf('https://missing.test/mcp', deps))
            .toBe('The address of that server could not be found.');
    });

    it('refuses a query string or a hash in the address, since a token could sit there', async () => {
        const message = 'Put the token in the secure form, not in the address.';

        expect(await refusalOf('https://mcp.linear.app/mcp?token=abc', depsWith(['93.184.216.34'])))
            .toBe(message);
        expect(await refusalOf('https://mcp.linear.app/mcp#abc', depsWith(['93.184.216.34'])))
            .toBe(message);
    });

    it('allows a private host only on the port the owner allowed, and 0 means any port', async () => {
        const allowed = [{ host: 'intranet.test', port: 8443 }];
        const anyPort = [{ host: 'intranet.test', port: 0 }];

        expect(await checkAppUrl('https://intranet.test:8443/mcp', depsWith(['10.0.0.5'], allowed)))
            .toMatchObject({ addresses: ['10.0.0.5'] });
        expect(await refusalOf('https://intranet.test:9000/mcp', depsWith(['10.0.0.5'], allowed)))
            .toContain('private or reserved');
        expect(await checkAppUrl('https://intranet.test:9000/mcp', depsWith(['10.0.0.5'], anyPort)))
            .toMatchObject({ addresses: ['10.0.0.5'] });
    });

    it('compares a port that is left out with the default port of the protocol', async () => {
        expect(await checkAppUrl('https://intranet.test/mcp', depsWith(['10.0.0.5'], [{ host: 'intranet.test', port: 443 }])))
            .toMatchObject({ addresses: ['10.0.0.5'] });
        expect(await refusalOf('http://intranet.test/mcp', depsWith(['10.0.0.5'], [{ host: 'intranet.test', port: 443 }])))
            .toContain('private or reserved');
    });
});
