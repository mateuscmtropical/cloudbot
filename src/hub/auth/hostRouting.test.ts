import { describe, expect, it } from 'vitest';

import { readHostRoute } from './hostRouting.ts';

describe('readHostRoute', () => {
    it('removes the port and recognizes the apex and a valid person name', () => {
        expect(readHostRoute('example.com:443', 'example.com'))
            .toEqual({ hostname: 'example.com', isApex: true });
        expect(readHostRoute('maria.example.com:443', 'example.com'))
            .toEqual({ hostname: 'maria.example.com', isApex: false, name: 'maria' });
    });

    it('keeps localhost ports out of the host name', () => {
        expect(readHostRoute('maria.localhost:3200', 'localhost'))
            .toEqual({ hostname: 'maria.localhost', isApex: false, name: 'maria' });
    });

    it('does not return a person name for invalid or nested subdomains', () => {
        expect(readHostRoute('maria.other.com', 'example.com')?.name)
            .toBeUndefined();
        expect(readHostRoute('nested.maria.example.com', 'example.com')?.name)
            .toBeUndefined();
        expect(readHostRoute('bad-.example.com', 'example.com')?.name)
            .toBeUndefined();
        expect(readHostRoute('attacker@maria.example.com', 'example.com'))
            .toBeUndefined();
    });
});

export {};
