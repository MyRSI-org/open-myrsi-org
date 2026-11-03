import { describe, it, expect } from 'vitest';
import { isPrivateIpv6Address, sanitizePublicLinkUrl } from '../lib/linkUrl';

// lib/linkUrl.ts isPrivateIpv6Address — the ROOT private-address predicate behind
// the SSRF DNS guard. It used to decode only the DOTTED IPv4-mapped spelling, so the
// HEX spelling WHATWG URL actually produces (`[::ffff:127.0.0.1]` serialises to
// `[::ffff:7f00:1]`) and the IPv4-translated form (`::ffff:0:X:Y`) were "public".
// lib/ssrf.ts patched its own call path; these pin the predicate itself, so no
// other caller inherits the hole. Pins:
//   * hex IPv4-mapped (::ffff:X:Y) and IPv4-translated (::ffff:0:X:Y) addresses
//     embedding a private v4 are private, in every spelling (bracketed, upper case,
//     fully written out, zero-padded, dotted tail, zone suffix, URL-canonicalised);
//   * a mapped/translated address embedding a PUBLIC v4 is not private;
//   * only the exact ::ffff:0:0/96 and ::ffff:0:0:0/96 prefixes are decoded — a
//     global address that merely contains an ffff group is not;
//   * malformed text is never decoded, never throws, and FAILS CLOSED: it is
//     reported private, so a lax parser that read it as some public address
//     would be caught here;
//   * sanitizePublicLinkUrl still refuses every IPv6 literal, public or not.

describe('isPrivateIpv6Address — hex IPv4-mapped (::ffff:X:Y)', () => {
    it.each([
        ['loopback 127.0.0.1', '::ffff:7f00:1'],
        ['loopback 127.255.255.254', '::ffff:7fff:fffe'],
        ['RFC1918 10.0.0.1', '::ffff:a00:1'],
        ['RFC1918 172.16.0.1', '::ffff:ac10:1'],
        ['RFC1918 192.168.1.1', '::ffff:c0a8:101'],
        ['link-local / cloud metadata 169.254.169.254', '::ffff:a9fe:a9fe'],
        ['this-network 0.0.0.0', '::ffff:0:0'],
        ['CGNAT 100.64.0.1', '::ffff:6440:1'],
        ['multicast 224.0.0.1', '::ffff:e000:1'],
        ['broadcast 255.255.255.255', '::ffff:ffff:ffff'],
    ])('%s (%s) is private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(true);
    });
});

describe('isPrivateIpv6Address — IPv4-translated (::ffff:0:X:Y)', () => {
    it.each([
        ['loopback 127.0.0.1', '::ffff:0:7f00:1'],
        ['RFC1918 10.0.0.1', '::ffff:0:a00:1'],
        ['RFC1918 192.168.0.1', '::ffff:0:c0a8:1'],
        ['link-local / cloud metadata 169.254.169.254', '::ffff:0:a9fe:a9fe'],
        ['this-network 0.0.0.0', '::ffff:0:0:0'],
    ])('%s (%s) is private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(true);
    });
});

describe('isPrivateIpv6Address — every spelling of a private mapped address', () => {
    it.each([
        ['bracketed', '[::ffff:7f00:1]'],
        ['bracketed translated', '[::ffff:0:a9fe:a9fe]'],
        ['upper case', '::FFFF:7F00:1'],
        ['fully written out', '0:0:0:0:0:ffff:7f00:1'],
        ['zero-padded', '0000:0000:0000:0000:0000:ffff:7f00:0001'],
        ['compression after a leading zero group', '0::ffff:a00:1'],
        ['fully written translated', '0:0:0:0:ffff:0:a00:1'],
        ['dotted tail, fully written', '0:0:0:0:0:ffff:10.0.0.1'],
        ['dotted translated', '::ffff:0:127.0.0.1'],
        ['zone suffix', '::ffff:7f00:1%lo'],
    ])('%s (%s) is private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(true);
    });

    it.each([
        ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]'],
        ['[::ffff:10.0.0.1]', '[::ffff:a00:1]'],
        ['[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]'],
        ['[::ffff:0.0.0.0]', '[::ffff:0:0]'],
        ['[::ffff:0:127.0.0.1]', '[::ffff:0:7f00:1]'],
        ['[0:0:0:0:ffff:0:10.0.0.1]', '[::ffff:0:a00:1]'],
        ['[0000:0000:0000:0000:0000:FFFF:C0A8:0001]', '[::ffff:c0a8:1]'],
    ])('the URL parser\'s canonical form of %s is private', (literal, canonical) => {
        // What reaches a guard is the WHATWG serialisation, not what was typed.
        const host = new URL(`https://${literal}/`).hostname;
        expect(host).toBe(canonical);
        expect(isPrivateIpv6Address(host)).toBe(true);
    });
});

describe('isPrivateIpv6Address — public embedded v4 stays allowed', () => {
    it.each([
        ['mapped 93.184.216.34', '::ffff:5db8:d822'],
        ['mapped 8.8.8.8', '::ffff:808:808'],
        ['mapped 1.1.1.1, fully written', '0:0:0:0:0:ffff:101:101'],
        ['translated 93.184.216.34', '::ffff:0:5db8:d822'],
        ['mapped 172.32.0.1 (just outside 172.16/12)', '::ffff:ac20:1'],
        ['mapped 8.8.8.8, dotted tail', '::ffff:8.8.8.8'],
        ['translated 93.184.216.34, dotted tail, fully written', '0:0:0:0:ffff:0:93.184.216.34'],
    ])('%s (%s) is not private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(false);
    });

    it('the URL parser\'s canonical form of a public mapped literal is not private', () => {
        const host = new URL('https://[::ffff:93.184.216.34]/').hostname;
        expect(host).toBe('[::ffff:5db8:d822]');
        expect(isPrivateIpv6Address(host)).toBe(false);
    });
});

describe('isPrivateIpv6Address — only the exact mapped/translated prefixes are decoded', () => {
    it.each([
        ['a non-zero group ahead of ffff', '1:0:0:0:0:ffff:7f00:1'],
        ['a non-zero fifth group ahead of ffff', '0:0:0:0:1:ffff:7f00:1'],
        ['fffe instead of ffff', '::fffe:7f00:1'],
        ['translated with a non-zero sixth group', '::ffff:1:7f00:1'],
        ['translated with a non-zero leading group', '1:0:0:0:ffff:0:7f00:1'],
        ['global unicast', '2606:4700:4700::1111'],
    ])('%s (%s) is not decoded as an embedded private v4', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(false);
    });
});

describe('isPrivateIpv6Address — malformed text fails closed and does not throw', () => {
    it.each([
        // Unparseable text has no single destination, so it is never "public". A lax
        // parser would read several of these as a PUBLIC address (1::2::3 as 1::2,
        // nine groups truncated to 1:2:…:8, a mapped prefix shifted one group), which
        // these assertions catch.
        ['two :: compressions', '1::2::3'],
        ['two :: compressions after a mapped-loopback prefix', '0:0:0:0:0:ffff:7f00::1::'],
        ['a non-hex group after ::', '::ffff:zz:1'],
        ['a non-hex group before ::', 'zz::ffff:7f00:1'],
        ['nine groups', '1:2:3:4:5:6:7:8:9'],
        ['nine groups whose first eight spell a mapped loopback', '0:0:0:0:0:ffff:7f00:1:9'],
        ['seven groups, no compression', '0:0:0:0:ffff:7f00:1'],
        ['compression standing for no groups', '0:0:0:0:0:ffff:7f00::1'],
    ])('%s (%s) is refused', (_label, addr) => {
        expect(() => isPrivateIpv6Address(addr)).not.toThrow();
        expect(isPrivateIpv6Address(addr)).toBe(true);
    });

    it('an out-of-range dotted octet is not an IPv4 tail: never decoded, refused as unparseable', () => {
        // 8<<8 | 512 would be 0x0a00, i.e. 10.0.x.x. The URL parser refuses this
        // literal and DNS never echoes it; it is not a mapped address, so it is not
        // decoded into the next octet — and, unparseable, it fails closed.
        expect(() => new URL('https://[::ffff:8.512.0.1]/')).toThrow();
        expect(isPrivateIpv6Address('::ffff:8.512.0.1')).toBe(true);
    });
});

describe('sanitizePublicLinkUrl still refuses IPv6 literals outright', () => {
    it.each([
        'https://[::ffff:93.184.216.34]/',
        'https://[::ffff:5db8:d822]/',
        'https://[::ffff:7f00:1]/',
        'https://[::ffff:0:a9fe:a9fe]/latest/meta-data/',
        'https://[2606:4700:4700::1111]/',
    ])('%s → null', (url) => {
        expect(sanitizePublicLinkUrl(url)).toBeNull();
    });

    it('a public hostname link is unaffected', () => {
        expect(sanitizePublicLinkUrl('https://example.com/a')).toBe('https://example.com/a');
    });
});
