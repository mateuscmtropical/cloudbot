import { describe, expect, it } from 'vitest';

import { readGoogleHubRoute } from './googleEndpoints.ts';

describe('readGoogleHubRoute', () => {
    it('takes the apex from the public address of the person', () => {
        expect(readGoogleHubRoute('https://maria.example.com', 'maria'))
            .toEqual({ personName: 'maria', apexOrigin: 'https://example.com' });
    });

    it('keeps the scheme and the port, as on a local hub', () => {
        expect(readGoogleHubRoute('http://maria.localhost:3100/', 'maria'))
            .toEqual({ personName: 'maria', apexOrigin: 'http://localhost:3100' });
    });

    it('works for an apex with several labels', () => {
        expect(readGoogleHubRoute('https://maria.bots.example.co.uk', 'maria'))
            .toEqual({ personName: 'maria', apexOrigin: 'https://bots.example.co.uk' });
    });

    it('answers undefined when the address does not start with the person name or is no address', () => {
        expect(readGoogleHubRoute('https://bot.example.com', 'maria'))
            .toBeUndefined();
        expect(readGoogleHubRoute('https://maria-two.example.com', 'maria'))
            .toBeUndefined();
        expect(readGoogleHubRoute('nonsense', 'maria'))
            .toBeUndefined();
        expect(readGoogleHubRoute(undefined, 'maria'))
            .toBeUndefined();
    });
});
