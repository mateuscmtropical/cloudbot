import { describe, expect, it } from 'vitest';

import type { BitwardenLoginItem } from './BitwardenCli.ts';
import { doesUriMatchPage, matchLoginItems } from './matchLoginItems.ts';

function item(id: string, name: string, uris: string[]): BitwardenLoginItem {
    return { id, name, uris, hasTotp: false };
}

describe('doesUriMatchPage', () => {
    it('matches the same host with any path', () => {
        expect(doesUriMatchPage('https://github.com/login', 'https://github.com'))
            .toBe(true);
        expect(doesUriMatchPage('https://GitHub.com', 'https://github.com'))
            .toBe(true);
    });

    it('matches an item that is only a host', () => {
        expect(doesUriMatchPage('github.com', 'https://github.com'))
            .toBe(true);
        expect(doesUriMatchPage('github.com/login', 'https://gist.github.com'))
            .toBe(true);
    });

    it('matches a page on a subdomain of the item host', () => {
        expect(doesUriMatchPage('https://github.com', 'https://gist.github.com'))
            .toBe(true);
        expect(doesUriMatchPage('https://github.com', 'https://a.b.github.com'))
            .toBe(true);
    });

    it('refuses look-alike hosts', () => {
        expect(doesUriMatchPage('https://github.com', 'https://github.com.evil.com'))
            .toBe(false);
        expect(doesUriMatchPage('https://github.com', 'https://evilgithub.com'))
            .toBe(false);
        expect(doesUriMatchPage('https://github.com', 'https://notgithub.com'))
            .toBe(false);
        expect(doesUriMatchPage('https://github.com', 'https://github.co'))
            .toBe(false);
    });

    it('does not let an item match the parent of its host', () => {
        expect(doesUriMatchPage('https://gist.github.com', 'https://github.com'))
            .toBe(false);
    });

    it('refuses a page on plain http', () => {
        expect(doesUriMatchPage('https://github.com', 'http://github.com'))
            .toBe(false);
    });

    it('refuses an item that names http or another scheme', () => {
        expect(doesUriMatchPage('http://github.com', 'https://github.com'))
            .toBe(false);
        expect(doesUriMatchPage('androidapp://com.github.android', 'https://github.com'))
            .toBe(false);
        expect(doesUriMatchPage('ftp://github.com', 'https://github.com'))
            .toBe(false);
    });

    it('needs the same port', () => {
        expect(doesUriMatchPage('https://example.com:8443', 'https://example.com:8443'))
            .toBe(true);
        expect(doesUriMatchPage('https://example.com:8443', 'https://example.com'))
            .toBe(false);
        expect(doesUriMatchPage('https://example.com', 'https://example.com:8443'))
            .toBe(false);
        expect(doesUriMatchPage('https://example.com:443', 'https://example.com'))
            .toBe(true);
    });

    it('does not let a bare suffix or an address match other hosts', () => {
        expect(doesUriMatchPage('https://com', 'https://github.com'))
            .toBe(false);
        expect(doesUriMatchPage('https://10.0.0.1', 'https://10.0.0.1'))
            .toBe(true);
        expect(doesUriMatchPage('https://0.0.1', 'https://10.0.0.1'))
            .toBe(false);
        expect(doesUriMatchPage('https://0.1', 'https://10.0.0.1'))
            .toBe(false);
    });

    it('ignores a trailing dot on a host', () => {
        expect(doesUriMatchPage('https://github.com.', 'https://github.com'))
            .toBe(true);
    });

    it('refuses an address that is not a URL', () => {
        expect(doesUriMatchPage('', 'https://github.com'))
            .toBe(false);
        expect(doesUriMatchPage('https://github.com', 'not a url'))
            .toBe(false);
        expect(doesUriMatchPage('  ', 'https://github.com'))
            .toBe(false);
    });
});

describe('matchLoginItems', () => {
    it('keeps the items with at least one matching address and skips the ones without any', () => {
        const items = [
            item('1', 'GitHub', ['https://github.com/login']),
            item('2', 'Other', ['https://example.com']),
            item('3', 'No addresses', []),
            item('4', 'Two', ['https://example.com', 'github.com']),
        ];
        const matches = matchLoginItems(items, 'https://github.com');

        expect(matches.map(match => match.id))
            .toEqual(['1', '4']);
    });
});
