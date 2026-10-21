import { describe, expect, it } from 'vitest';

import { embeddedIpv4, expandIpv6, isPublicAddress } from './publicAddress.ts';

describe('isPublicAddress', () => {
    it.each([
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.1',
        '169.254.10.20',
        '100.64.0.1',
        '0.0.0.0',
        '198.18.0.1',
        '224.0.0.1',
        '255.255.255.255',
        '192.0.0.8',
        '::1',
        '::',
        'fe80::1',
        'fc00::1',
        'fd12:3456::1',
        'fd00:ec2::254',
        'ff02::1',
        '::127.0.0.1',
        '::7f00:1',
        '2001:0:4136:e378:8000:63bf:3fff:fdd2',
        '2001:db8::1',
        '100::1',
    ])('refuses %s', (address) => {
        expect(isPublicAddress(address))
            .toBe(false);
    });

    it.each([
        '8.8.8.8',
        '1.1.1.1',
        '172.32.0.1',
        '2606:4700:4700::1111',
    ])('allows %s', (address) => {
        expect(isPublicAddress(address))
            .toBe(true);
    });

    it('refuses text that is not an address', () => {
        expect(isPublicAddress('example.com'))
            .toBe(false);
        expect(isPublicAddress('::ffff:not-an-address'))
            .toBe(false);
    });

    it('refuses an address the server itself listens on', () => {
        expect(isPublicAddress('203.0.113.7', ['203.0.113.7']))
            .toBe(false);
        expect(isPublicAddress('203.0.113.7', ['198.51.100.1']))
            .toBe(true);
    });
});

describe('IPv4-mapped addresses (::ffff:0:0/96)', () => {
    it.each([
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        '::ffff:10.0.0.1',
        '::ffff:a9fe:a9fe',
    ])('refuses %s, because its IPv4 part is private', (address) => {
        expect(isPublicAddress(address))
            .toBe(false);
    });

    it('allows a mapped public address', () => {
        expect(isPublicAddress('::ffff:8.8.8.8'))
            .toBe(true);
        expect(isPublicAddress('::ffff:0808:0808'))
            .toBe(true);
    });
});

describe('NAT64 addresses (64:ff9b::/96)', () => {
    it('refuses a NAT64 address that embeds 127.0.0.1, in both written forms', () => {
        expect(isPublicAddress('64:ff9b::7f00:1'))
            .toBe(false);
        expect(isPublicAddress('64:ff9b::127.0.0.1'))
            .toBe(false);
    });

    it('refuses a NAT64 address that embeds the cloud metadata address', () => {
        expect(isPublicAddress('64:ff9b::a9fe:a9fe'))
            .toBe(false);
    });

    it('allows a NAT64 address that embeds a public IPv4 address', () => {
        expect(isPublicAddress('64:ff9b::808:808'))
            .toBe(true);
    });
});

describe('6to4 addresses (2002::/16)', () => {
    it('refuses a 6to4 address that embeds 127.0.0.1', () => {
        expect(isPublicAddress('2002:7f00:1::1'))
            .toBe(false);
    });

    it('allows a 6to4 address that embeds a public IPv4 address', () => {
        expect(isPublicAddress('2002:808:808::1'))
            .toBe(true);
    });
});

describe('embeddedIpv4 and expandIpv6', () => {
    it('reads the IPv4 part of the forms that carry one', () => {
        expect(embeddedIpv4(expandIpv6('::ffff:1.2.3.4') ?? []))
            .toBe('1.2.3.4');
        expect(embeddedIpv4(expandIpv6('64:ff9b::7f00:1') ?? []))
            .toBe('127.0.0.1');
        expect(embeddedIpv4(expandIpv6('2002:7f00:1::1') ?? []))
            .toBe('127.0.0.1');
    });

    it('returns undefined for an address that carries no IPv4 part', () => {
        expect(embeddedIpv4(expandIpv6('2606:4700:4700::1111') ?? []))
            .toBeUndefined();
    });

    it('refuses an IPv6 address with too many groups', () => {
        expect(expandIpv6('1:2:3:4:5:6:7:8:9'))
            .toBeUndefined();
    });
});
