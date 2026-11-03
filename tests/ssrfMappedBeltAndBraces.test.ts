// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// lib/ssrf.ts assertResolvesToPublicHost keeps its own hex IPv4-mapped decode
// (hexMappedIpv4) even though the root predicate, isPrivateIpv6Address in
// lib/linkUrl.ts, now decodes that form itself. It is deliberate belt-and-braces:
// `https://[::ffff:169.254.169.254]/` reaches the guard as `::ffff:a9fe:a9fe`, and
// that spelling has slipped past the root predicate before. Here the root IPv6
// predicate is stubbed to "public" (simulating a regression in it) while the IPv4
// predicate stays REAL, so these pin that ssrf.ts alone still:
//   * refuses a hex-mapped answer embedding a private v4, in either case, alone or
//     in a mixed answer;
//   * accepts a hex-mapped answer embedding a public v4.
// The canaries prove the stub is in effect INSIDE lib/ssrf.ts, not just in this
// file's own import: under it, a private IPv6 answer that is NOT hex-mapped
// (fe80::1, ::1, fd00::1) reaches no other check and is accepted — the real
// predicate would refuse every one. And the IPv4 predicate ssrf.ts calls is the
// real one, so a private IPv4 answer is still refused.

const h = vi.hoisted(() => ({
    lookupResult: [] as Array<{ address: string; family: number }>,
}));

vi.mock('node:dns/promises', () => {
    const lookup = async () => h.lookupResult;
    return { lookup, default: { lookup } };
});
vi.mock('../lib/linkUrl', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/linkUrl')>()),
    isPrivateIpv6Address: () => false,
}));

import { assertResolvesToPublicHost } from '../lib/ssrf';
import { isPrivateIpv6Address } from '../lib/linkUrl';

beforeEach(() => {
    h.lookupResult = [];
});

describe('assertResolvesToPublicHost — hex-mapped belt-and-braces', () => {
    it('runs with the root IPv6 predicate stubbed to "public"', () => {
        expect(isPrivateIpv6Address('::1')).toBe(false);
    });

    it.each([
        ['link-local', 'fe80::1'],
        ['loopback', '::1'],
        ['unique-local', 'fd00::1'],
    ])('lib/ssrf.ts itself sees the stub: a non-mapped private %s answer (%s) is ACCEPTED', async (_label, address) => {
        // Only passes when the stub replaced the predicate ssrf.ts calls. Were it the
        // real one, each of these would be refused as private/reserved.
        h.lookupResult = [{ address, family: 6 }];
        await expect(assertResolvesToPublicHost('https://canary.example/')).resolves.toEqual([{ address, family: 6 }]);
    });

    it('lib/ssrf.ts still calls the REAL IPv4 predicate under the partial mock', async () => {
        h.lookupResult = [{ address: '10.0.0.1', family: 4 }];
        await expect(assertResolvesToPublicHost('https://canary.example/')).rejects.toThrow(
            'Peer host resolves to a private/reserved address',
        );
    });

    it.each([
        ['loopback 127.0.0.1', '::ffff:7f00:1'],
        ['RFC1918 10.0.0.1', '::ffff:a00:1'],
        ['RFC1918 192.168.1.1', '::ffff:c0a8:101'],
        ['cloud metadata 169.254.169.254', '::ffff:a9fe:a9fe'],
        ['this-network 0.0.0.0', '::ffff:0:0'],
        ['upper case cloud metadata', '::FFFF:A9FE:A9FE'],
    ])('still refuses a hex-mapped %s answer (%s)', async (_label, address) => {
        h.lookupResult = [{ address, family: 6 }];
        await expect(assertResolvesToPublicHost('https://rebind.example/')).rejects.toThrow(
            'Peer host resolves to a private/reserved address',
        );
    });

    it('refuses the exact form the URL parser produces for a mapped metadata literal', async () => {
        const url = 'https://[::ffff:169.254.169.254]/latest/meta-data/';
        const host = new URL(url).hostname;
        expect(host).toBe('[::ffff:a9fe:a9fe]');
        h.lookupResult = [{ address: host.slice(1, -1), family: 6 }];
        await expect(assertResolvesToPublicHost(url)).rejects.toThrow(/private\/reserved/);
    });

    it('a mixed answer is refused when any one is a private hex-mapped address', async () => {
        h.lookupResult = [
            { address: '2606:4700::1', family: 6 },
            { address: '::ffff:a00:1', family: 6 },
        ];
        await expect(assertResolvesToPublicHost('https://mixed.example/')).rejects.toThrow(/private\/reserved/);
    });

    it.each([
        ['mapped 93.184.216.34', '::ffff:5db8:d822'],
        ['mapped 8.8.8.8', '::ffff:808:808'],
    ])('accepts a hex-mapped %s answer (%s)', async (_label, address) => {
        h.lookupResult = [{ address, family: 6 }];
        await expect(assertResolvesToPublicHost('https://peer.example/')).resolves.toEqual(h.lookupResult);
    });

    it('a public IPv4 answer alongside is unaffected', async () => {
        h.lookupResult = [
            { address: '93.184.216.34', family: 4 },
            { address: '::ffff:5db8:d822', family: 6 },
        ];
        await expect(assertResolvesToPublicHost('https://peer.example/')).resolves.toEqual(h.lookupResult);
    });
});
