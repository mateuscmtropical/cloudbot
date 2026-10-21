import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

// Addresses a watched page may never be fetched from: loopback, private, link-local, shared (CGNAT),
// multicast, reserved, benchmarking and broadcast ranges, plus the cloud metadata address over IPv6.
// Addresses that carry an IPv4 address inside (mapped, NAT64 and 6to4) are checked by that IPv4 address.
const blockedAddresses = new BlockList();

const BLOCKED_IPV4_SUBNETS: [string, number][] = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
];

// Inside the global unicast range, Teredo (it hides an IPv4 address) and the documentation range are refused too.
const BLOCKED_IPV6_SUBNETS: [string, number][] = [
    ['2001::', 32],
    ['2001:db8::', 32],
];

// Only global unicast IPv6 can be public. Everything outside it, such as ::1, ::a.b.c.d, fc00::/7, fe80::/10 and ff00::/8, is refused.
const globalUnicast = new BlockList();

globalUnicast.addSubnet('2000::', 3, 'ipv6');

const BLOCKED_IPV6_ADDRESSES: string[] = [
    'fd00:ec2::254',
];

BLOCKED_IPV4_SUBNETS.forEach(([network, prefix]) => {
    blockedAddresses.addSubnet(network, prefix, 'ipv4');
});

BLOCKED_IPV6_SUBNETS.forEach(([network, prefix]) => {
    blockedAddresses.addSubnet(network, prefix, 'ipv6');
});

BLOCKED_IPV6_ADDRESSES.forEach((address) => {
    blockedAddresses.addAddress(address, 'ipv6');
});

const HEXTET_PATTERN = /^[0-9a-f]{1,4}$/i;
const EMBEDDED_IPV4_PATTERN = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/;

// Turns the dotted IPv4 at the end of an IPv6 address into two hextets, so the text is always plain hex.
function replaceDottedTail(address: string): string | undefined {
    const dottedParts = EMBEDDED_IPV4_PATTERN.exec(address);

    if (dottedParts === null) {
        return address;
    }

    const head = dottedParts[1] ?? '';
    const octets = (dottedParts[2] ?? '').split('.')
        .map(octet => Number.parseInt(octet, 10));
    const [first, second, third, fourth] = octets;

    const isEveryOctetValid = octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255);

    if (first === undefined || second === undefined || third === undefined || fourth === undefined || !isEveryOctetValid) {
        return undefined;
    }

    return `${head}${((first << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`;
}

// The eight 16-bit groups of an IPv6 address, or undefined when the text cannot be read.
function expandIpv6(address: string): number[] | undefined {
    const plainAddress = replaceDottedTail(address);

    if (plainAddress === undefined) {
        return undefined;
    }

    const halves = plainAddress.split('::');

    if (halves.length > 2) {
        return undefined;
    }

    const headText = halves[0] ?? '';
    const tailText = halves[1] ?? '';
    const head = headText === '' ? [] : headText.split(':');
    const tail = halves.length === 2 && tailText !== '' ? tailText.split(':') : [];
    const missingCount = 8 - head.length - tail.length;

    if (halves.length === 1 ? missingCount !== 0 : missingCount < 1) {
        return undefined;
    }

    const zeros = Array.from({ length: missingCount }, () => '0');
    const groups = [...head, ...zeros, ...tail];

    if (!groups.every(group => HEXTET_PATTERN.test(group))) {
        return undefined;
    }

    return groups.map(group => Number.parseInt(group, 16));
}

function dottedFromGroups(high: number, low: number): string {
    return `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`;
}

function isZeroRange(groups: number[], from: number, to: number): boolean {
    return groups.slice(from, to)
        .every(group => group === 0);
}

// The IPv4 address an IPv6 address carries, for the mapped, NAT64 and 6to4 forms. Undefined for other addresses.
function embeddedIpv4(groups: number[]): string | undefined {
    const isMapped = isZeroRange(groups, 0, 5) && groups[5] === 0xFFFF;
    const isNat64 = groups[0] === 0x64 && groups[1] === 0xFF9B && isZeroRange(groups, 2, 6);

    if (isMapped || isNat64) {
        return dottedFromGroups(groups[6] ?? 0, groups[7] ?? 0);
    }

    if (groups[0] === 0x2002) {
        return dottedFromGroups(groups[1] ?? 0, groups[2] ?? 0);
    }

    return undefined;
}

// Fails closed: text that is not an IP address, or an IPv6 address that cannot be read, is not public.
function isPublicAddress(address: string, localAddresses: string[] = []): boolean {
    const family = isIP(address);

    if (family === 0 || localAddresses.includes(address)) {
        return false;
    }

    if (family === 4) {
        return !blockedAddresses.check(address, 'ipv4');
    }

    const groups = expandIpv6(address);

    if (groups === undefined) {
        return false;
    }

    const innerIpv4 = embeddedIpv4(groups);

    if (innerIpv4 !== undefined) {
        return isPublicAddress(innerIpv4, localAddresses);
    }

    return globalUnicast.check(address, 'ipv6') && !blockedAddresses.check(address, 'ipv6');
}

// The private ranges an owner may allow the browser to reach. Loopback, unspecified, link-local, multicast and the
// metadata addresses are not in these lists, so they are never allowable.
const ALLOWABLE_PRIVATE_IPV4_SUBNETS: [string, number][] = [
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
];
const allowablePrivateIpv4 = new BlockList();
const allowablePrivateIpv6 = new BlockList();
// Cloud metadata addresses. Alibaba Cloud serves its metadata on 100.100.100.200, which sits inside 100.64/10.
const METADATA_IPV4_ADDRESSES = new Set(['169.254.169.254', '100.100.100.200']);

ALLOWABLE_PRIVATE_IPV4_SUBNETS.forEach(([network, prefix]) => {
    allowablePrivateIpv4.addSubnet(network, prefix, 'ipv4');
});

allowablePrivateIpv6.addSubnet('fc00::', 7, 'ipv6');

// True for a private address an owner may allow: 10/8, 100.64/10, 172.16/12, 192.168/16 and fc00::/7. Mapped and
// NAT64 addresses are checked by their IPv4 address. Loopback, this machine's own addresses, unspecified, link-local
// and the metadata addresses are never allowable, even when the owner allowed their host.
function isAllowablePrivateAddress(address: string, localAddresses: string[] = []): boolean {
    const family = isIP(address);

    if (family === 0 || localAddresses.includes(address)) {
        return false;
    }

    if (family === 4) {
        return !METADATA_IPV4_ADDRESSES.has(address) && allowablePrivateIpv4.check(address, 'ipv4');
    }

    const groups = expandIpv6(address);

    if (groups === undefined) {
        return false;
    }

    const innerIpv4 = embeddedIpv4(groups);

    if (innerIpv4 !== undefined) {
        return isAllowablePrivateAddress(innerIpv4, localAddresses);
    }

    return allowablePrivateIpv6.check(address, 'ipv6') && !blockedAddresses.check(address, 'ipv6');
}

// The addresses this machine answers on. Its own addresses are never public, even when they look public.
function readLocalAddresses(): string[] {
    const networkTable = networkInterfaces();
    const interfaceLists = Object.values(networkTable);

    return interfaceLists.flatMap(entries => (entries ?? []).map(entry => entry.address));
}

export { embeddedIpv4, expandIpv6, isAllowablePrivateAddress, isPublicAddress, readLocalAddresses };
