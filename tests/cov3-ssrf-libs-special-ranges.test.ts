// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/linkUrl.ts private-address predicates and the SSRF guard that consumes them
// (lib/ssrf.ts). These pin the special-purpose ranges that used to be treated as
// PUBLIC, so an outbound credentialed fetch (alliance federation, intel feeds, RSI
// verify) could be pointed at them by a DNS answer, and a public link
// (sanitizePublicLinkUrl: org page, settings, academy, intel evidence, importer)
// could carry them as an IPv4 literal:
//   * IPv4: 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 198.18.0.0/15,
//     198.51.100.0/24, 203.0.113.0/24 — alongside the ranges already blocked;
//   * IPv6: 64:ff9b:1::/48, 100::/64, 100:0:0:1::/64, 2001::/23, 2001:db8::/32,
//     3fff::/20, 5f00::/16, fec0::/10, ff00::/8 — decoded from the eight groups,
//     so every spelling counts;
//   * both predicates FAIL CLOSED on text that is not a well-formed address.
// Each range is pinned on both edges inside and on the nearest address outside it.
// Where the outside neighbour of an IPv6 range is IETF-reserved space that no rule
// refuses today, that neighbour is labelled as such: it pins the prefix arithmetic,
// not a judgement that reserved space is public.
//
// DNS and undici are doubled (no network); the predicates are REAL throughout.

const h = vi.hoisted(() => ({
    lookupResult: [] as Array<{ address: string; family: number }>,
    lookupCalls: [] as string[],
    fetchCalls: [] as string[],
    agents: 0,
}));

vi.mock('node:dns/promises', () => {
    const lookup = async (host: string) => {
        h.lookupCalls.push(host);
        return h.lookupResult;
    };
    return { lookup, default: { lookup } };
});

vi.mock('undici', () => ({
    Agent: class {
        constructor() { h.agents += 1; }
        close() { return Promise.resolve(); }
    },
    fetch: async (url: string) => {
        h.fetchCalls.push(url);
        return { status: 200, statusText: 'OK', headers: new Headers(), body: null };
    },
}));

import { isPrivateIpv4, isPrivateIpv6Address, sanitizePublicLinkUrl } from '../lib/linkUrl';
import { assertResolvesToPublicHost, ssrfSafeFetch } from '../lib/ssrf';

beforeEach(() => {
    h.lookupResult = [];
    h.lookupCalls = [];
    h.fetchCalls = [];
    h.agents = 0;
});

type Range = { range: string; inside: string[]; outside: string[] };
const insideCases = (table: Range[]) => table.flatMap((r) => r.inside.map((a) => [r.range, a] as const));
const outsideCases = (table: Range[]) => table.flatMap((r) => r.outside.map((a) => [r.range, a] as const));

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

const V4: Range[] = [
    { range: '0.0.0.0/8 this-network', inside: ['0.0.0.0', '0.255.255.255'], outside: ['1.0.0.0'] },
    { range: '10.0.0.0/8 RFC 1918', inside: ['10.0.0.0', '10.255.255.255'], outside: ['9.255.255.255', '11.0.0.0'] },
    { range: '100.64.0.0/10 CGNAT', inside: ['100.64.0.0', '100.127.255.255'], outside: ['100.63.255.255', '100.128.0.0'] },
    { range: '127.0.0.0/8 loopback', inside: ['127.0.0.0', '127.255.255.255'], outside: ['126.255.255.255', '128.0.0.0'] },
    { range: '169.254.0.0/16 link-local', inside: ['169.254.0.0', '169.254.169.254', '169.254.255.255'], outside: ['169.253.255.255', '169.255.0.0'] },
    { range: '172.16.0.0/12 RFC 1918', inside: ['172.16.0.0', '172.31.255.255'], outside: ['172.15.255.255', '172.32.0.0'] },
    {
        range: '192.0.0.0/24 IETF protocol assignments',
        inside: ['192.0.0.0', '192.0.0.8', '192.0.0.255'],
        outside: ['191.255.255.255', '192.0.1.0'],
    },
    {
        range: '192.0.2.0/24 TEST-NET-1',
        inside: ['192.0.2.0', '192.0.2.1', '192.0.2.255'],
        // 192.0.20.1 shares the text prefix "192.0.2" but not the octet.
        outside: ['192.0.1.255', '192.0.3.0', '192.0.20.1'],
    },
    {
        range: '192.88.99.0/24 6to4 relay anycast',
        inside: ['192.88.99.0', '192.88.99.255'],
        outside: ['192.88.98.255', '192.88.100.0', '192.88.9.1'],
    },
    { range: '192.168.0.0/16 RFC 1918', inside: ['192.168.0.0', '192.168.255.255'], outside: ['192.167.255.255', '192.169.0.0'] },
    {
        range: '198.18.0.0/15 benchmarking',
        inside: ['198.18.0.0', '198.18.255.255', '198.19.0.0', '198.19.255.255'],
        outside: ['198.17.255.255', '198.20.0.0', '198.180.0.1', '198.190.0.1'],
    },
    {
        range: '198.51.100.0/24 TEST-NET-2',
        inside: ['198.51.100.0', '198.51.100.255'],
        outside: ['198.51.99.255', '198.51.101.0', '198.51.10.1'],
    },
    {
        range: '203.0.113.0/24 TEST-NET-3',
        inside: ['203.0.113.0', '203.0.113.255'],
        outside: ['203.0.112.255', '203.0.114.0', '203.0.11.3'],
    },
    // 224.0.0.0/4 and 240.0.0.0/4 abut, so together they refuse 224.0.0.0 to
    // 255.255.255.255; the one outside edge is below 224.
    { range: '224.0.0.0/4 multicast', inside: ['224.0.0.0', '239.255.255.255'], outside: ['223.255.255.255'] },
    { range: '240.0.0.0/4 reserved, with broadcast', inside: ['240.0.0.0', '255.255.255.254', '255.255.255.255'], outside: [] },
];

describe('isPrivateIpv4 — every non-public range, both edges', () => {
    it.each(insideCases(V4))('%s: %s is private', (_range, addr) => {
        expect(isPrivateIpv4(addr)).toBe(true);
    });

    it.each(outsideCases(V4))('%s: %s (outside) is not private', (_range, addr) => {
        expect(isPrivateIpv4(addr)).toBe(false);
    });

    it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '104.16.132.229'])('ordinary public %s is not private', (addr) => {
        expect(isPrivateIpv4(addr)).toBe(false);
    });
});

describe('isPrivateIpv4 — fails closed on anything that is not a well-formed dotted quad', () => {
    it.each([
        ['empty', ''],
        ['three octets', '8.8.8'],
        ['five octets', '8.8.8.8.8'],
        ['an empty octet', '8..8.8'],
        ['first octet over 255', '256.8.8.8'],
        ['last octet over 255', '8.8.8.256'],
        ['a 300 octet', '8.8.300.8'],
        ['leading zero (octal to inet_aton: 010 is 8)', '010.0.0.1'],
        ['leading zero in the last octet', '8.8.8.08'],
        ['a 00 octet', '8.8.8.00'],
        ['leading space', ' 8.8.8.8'],
        ['trailing space', '8.8.8.8 '],
        ['trailing newline', '8.8.8.8\n'],
        ['a CIDR suffix', '8.8.8.8/32'],
        ['a port', '8.8.8.8:443'],
        ['hex octet', '0x8.8.8.8'],
        ['one 32-bit number', '134744072'],
        ['a negative octet', '-8.8.8.8'],
        ['letters', 'a.b.c.d'],
        ['a hostname', 'dns.google'],
    ])('%s (%j) is refused', (_label, addr) => {
        expect(isPrivateIpv4(addr)).toBe(true);
    });

    it.each(['8.8.8.0', '8.8.8.9', '8.8.8.10', '8.8.8.99', '8.8.8.100', '8.8.8.199', '8.8.8.200', '8.8.8.249', '8.8.8.250', '8.8.8.255'])(
        'every octet width up to 255 is well formed: %s is not private',
        (addr) => {
            expect(isPrivateIpv4(addr)).toBe(false);
        },
    );
});

describe('the new IPv4 ranges propagate through every IPv6 transition decode', () => {
    it.each([
        ['mapped TEST-NET-1, dotted', '::ffff:192.0.2.1'],
        ['mapped TEST-NET-1, hex', '::ffff:c000:201'],
        ['translated benchmarking', '::ffff:0:c612:1'],
        ['NAT64 of TEST-NET-2', '64:ff9b::c633:6401'],
        ['6to4 of TEST-NET-3', '2002:cb00:7101::'],
        ['IPv4-compatible 6to4 relay anycast', '::c058:6301'],
        ['NAT64 of 192.0.0.8', '64:ff9b::c000:8'],
    ])('%s (%s) is private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(true);
    });

    it.each([
        ['mapped 192.0.3.1, just past TEST-NET-1', '::ffff:c000:301'],
        ['NAT64 of 198.20.0.1, just past benchmarking', '64:ff9b::c614:1'],
        ['6to4 of 203.0.114.1, just past TEST-NET-3', '2002:cb00:7201::'],
    ])('%s (%s) is not private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// IPv6
// ---------------------------------------------------------------------------

const V6: Range[] = [
    {
        range: '64:ff9b:1::/48 local-use NAT64',
        // Refused whole: an embedded public v4 (8.8.8.8) does not rescue it.
        inside: ['64:ff9b:1::', '64:ff9b:1::808:808', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', '0064:ff9b:0001:0000:0000:0000:0000:0001'],
        // 64:ff9b::/96 (the well-known NAT64 prefix) IS globally reachable.
        outside: ['64:ff9b::808:808', '64:ff9b:2::'],
    },
    {
        range: '100::/64 discard-only',
        inside: ['100::', '100::1', '100::ffff:ffff:ffff:ffff', '0100:0000:0000:0000:0000:0000:0000:0000'],
        // IETF-reserved neighbour, not refused today (pins the /64 arithmetic).
        outside: ['ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
    },
    {
        range: '100:0:0:1::/64 dummy prefix',
        inside: ['100:0:0:1::', '100:0:0:1:ffff:ffff:ffff:ffff'],
        // IETF-reserved neighbours, not refused today (pins the /64 arithmetic).
        outside: ['100:0:0:2::', '100:1::'],
    },
    {
        range: '2001::/23 IETF protocol assignments',
        inside: [
            '2001::',
            '2001::1',
            '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo 2001::/32
            '2001:1::1', // PCP anycast
            '2001:1::2', // TURN anycast
            '2001:2::1', // benchmarking 2001:2::/48
            '2001:3::1', // AMT
            '2001:4:112::1', // AS112-v6
            '2001:10::1', // ORCHID (deprecated)
            '2001:20::1', // ORCHIDv2
            '2001:30::1', // DRIP DETs
            '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', // the last address of the /23
            '2001:0000:0000:0000:0000:0000:0000:0001',
            '[2001:1FF::1]',
        ],
        // Ordinary global unicast on both sides, including Google Public DNS.
        outside: ['2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '2001:200::', '2001:200::1', '2001:4860:4860::8888'],
    },
    {
        range: '2001:db8::/32 documentation',
        inside: ['2001:db8::', '2001:db8::1', '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', '2001:0db8:85a3:0000:0000:8a2e:0370:7334', '2001:DB8::1'],
        outside: ['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', '2001:db9::'],
    },
    {
        range: '3fff::/20 documentation',
        inside: ['3fff::', '3fff::1', '3fff:abc::1', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff'],
        outside: ['3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '3fff:1000::', '3fff:ffff::1'],
    },
    {
        range: '5f00::/16 SRv6 SIDs',
        inside: ['5f00::', '5f00::1', '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
        // IETF-reserved neighbours, not refused today (pins the /16 arithmetic).
        outside: ['5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', '5f01::'],
    },
    {
        range: 'fec0::/10 site-local',
        // Its neighbours are link-local (febf:…) below and multicast (ff00::) above,
        // both refused by other rules (pinned in the abutting-ranges test).
        inside: ['fec0::', 'fec0::1', 'feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'FEC0::1', '[fed0::1]'],
        outside: [],
    },
    {
        range: 'ff00::/8 multicast',
        inside: ['ff00::', 'ff02::1', 'ff05::1:3', 'ff0e::101', 'FF02::FB', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
        // Not multicast: the ff group compressed to its low byte.
        outside: ['ff::1'],
    },
];

describe('isPrivateIpv6Address — every special-purpose range, both edges', () => {
    it.each(insideCases(V6))('%s: %s is private', (_range, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(true);
    });

    it.each(outsideCases(V6))('%s: %s (outside) is not private', (_range, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(false);
    });

    it('fe80::/10, fec0::/10 and ff00::/8 abut: the edges between them are all refused', () => {
        expect(isPrivateIpv6Address('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true); // last link-local
        expect(isPrivateIpv6Address('fec0::')).toBe(true); // first site-local
        expect(isPrivateIpv6Address('feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true); // last site-local
        expect(isPrivateIpv6Address('ff00::')).toBe(true); // first multicast
    });

    it.each([
        ['Google Public DNS', '2001:4860:4860::8888'],
        ['Cloudflare DNS', '2606:4700:4700::1111'],
        ['a 2001:200::/23 (APNIC) address', '2001:200:dff:fff1:216:3eff:feb1:44d7'],
        ['an AS112 direct-delegation address (globally reachable)', '2620:4f:8000::1'],
    ])('ordinary global unicast — %s (%s) stays public', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(false);
    });

    it.each([
        ['[2001:0db8:0000::1]', '[2001:db8::1]'],
        ['[64:ff9b:1:0:0:0:0:0]', '[64:ff9b:1::]'],
        ['[FEC0::1]', '[fec0::1]'],
        ['[2001:0:4136:e378:8000:63bf:3fff:fdd2]', '[2001:0:4136:e378:8000:63bf:3fff:fdd2]'],
    ])('the URL parser\'s canonical form of %s is private', (literal, canonical) => {
        const host = new URL(`https://${literal}/`).hostname;
        expect(host).toBe(canonical);
        expect(isPrivateIpv6Address(host)).toBe(true);
    });

    it('a zone suffix does not hide a special-purpose prefix', () => {
        expect(isPrivateIpv6Address('ff02::1%eth0')).toBe(true);
        expect(isPrivateIpv6Address('2001:db8::1%2')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// The SSRF guard: a DNS answer in any of these ranges is refused before a request
// ---------------------------------------------------------------------------

describe('assertResolvesToPublicHost — refuses a DNS answer in a special-purpose range', () => {
    it.each([
        ['192.0.0.8', 4],
        ['192.0.2.10', 4],
        ['192.88.99.1', 4],
        ['198.18.0.1', 4],
        ['198.19.255.254', 4],
        ['198.51.100.7', 4],
        ['203.0.113.9', 4],
        ['64:ff9b:1::a9fe:a9fe', 6],
        ['100::1', 6],
        ['100:0:0:1::1', 6],
        ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 6],
        ['2001:2::1', 6],
        ['2001:db8::1', 6],
        ['3fff::1', 6],
        ['5f00::1', 6],
        ['fec0::1', 6],
        ['ff02::1', 6],
    ])('refuses %s (family %i)', async (address, family) => {
        h.lookupResult = [{ address, family }];
        await expect(assertResolvesToPublicHost('https://peer.example/')).rejects.toThrow(
            'Peer host resolves to a private/reserved address',
        );
        expect(h.lookupCalls).toEqual(['peer.example']);
    });

    it('refuses a mixed answer when any one address is special-purpose', async () => {
        h.lookupResult = [
            { address: '93.184.216.34', family: 4 },
            { address: '2001:4860:4860::8888', family: 6 },
            { address: '2001:db8::7', family: 6 },
        ];
        await expect(assertResolvesToPublicHost('https://mixed.example/')).rejects.toThrow(/private\/reserved/);
    });

    it('accepts the global-unicast neighbours and returns every vetted answer', async () => {
        h.lookupResult = [
            { address: '2001:4860:4860::8888', family: 6 },
            { address: '2001:200::1', family: 6 },
            { address: '2001:db9::1', family: 6 },
            { address: '3fff:1000::1', family: 6 },
            { address: '192.0.3.1', family: 4 },
            { address: '198.20.0.1', family: 4 },
            { address: '203.0.114.1', family: 4 },
        ];
        await expect(assertResolvesToPublicHost('https://peer.example/')).resolves.toEqual(h.lookupResult);
    });

    it('ssrfSafeFetch makes no request and builds no Agent for a Teredo answer', async () => {
        h.lookupResult = [{ address: '2001::1', family: 6 }];
        await expect(ssrfSafeFetch('https://teredo.example/api/alliance/profile', { headers: { 'x-api-key': 'k' } }))
            .rejects.toThrow('Peer host resolves to a private/reserved address');
        expect(h.fetchCalls).toEqual([]);
        expect(h.agents).toBe(0);
    });

    it('ssrfSafeFetch still fetches a host that resolves to Google Public DNS over IPv6', async () => {
        h.lookupResult = [{ address: '2001:4860:4860::8888', family: 6 }];
        const res = await ssrfSafeFetch('https://dns.example/x');
        expect(res.status).toBe(200);
        expect(h.fetchCalls).toEqual(['https://dns.example/x']);
        expect(h.agents).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Public link sanitising: IPv4 literals in the new ranges are refused
// ---------------------------------------------------------------------------

describe('sanitizePublicLinkUrl — IPv4 literals in the newly blocked ranges', () => {
    it.each([
        'https://192.0.0.8/',
        'https://192.0.2.1/x',
        'https://192.88.99.1/',
        'https://198.18.0.1/',
        'https://198.19.255.255/',
        'https://198.51.100.7/a?b=1',
        'https://203.0.113.9/',
        // Every spelling the URL parser folds to 192.0.2.1.
        'https://3221225985/',
        'https://0xc0.0.2.1/',
        'https://0300.0.2.1/',
        'https://192.0.513/',
    ])('%s → null', (url) => {
        expect(sanitizePublicLinkUrl(url)).toBeNull();
    });

    it.each([
        ['https://192.0.3.0/', 'https://192.0.3.0/'],
        ['https://192.0.20.1/x', 'https://192.0.20.1/x'],
        ['https://198.20.0.0/', 'https://198.20.0.0/'],
        ['https://198.180.0.1/', 'https://198.180.0.1/'],
        ['https://203.0.114.0/', 'https://203.0.114.0/'],
        ['https://8.8.8.8/', 'https://8.8.8.8/'],
    ])('the public neighbour %s is kept', (url, expected) => {
        expect(sanitizePublicLinkUrl(url)).toBe(expected);
    });

    it('still refuses every IPv6 literal, including public global unicast', () => {
        expect(sanitizePublicLinkUrl('https://[2001:4860:4860::8888]/')).toBeNull();
        expect(sanitizePublicLinkUrl('https://[2001:db8::1]/')).toBeNull();
    });
});
