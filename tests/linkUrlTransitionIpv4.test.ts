import { describe, it, expect } from 'vitest';
import { isPrivateIpv6Address } from '../lib/linkUrl';

// lib/linkUrl.ts isPrivateIpv6Address — the transition ranges that carry an IPv4
// destination inside an IPv6 address: 6to4 (2002::/16, the v4 in groups 1-2),
// NAT64 (64:ff9b::/96, the v4 in groups 6-7) and IPv4-compatible (::/96, groups 6-7).
// They used to be decoded by text patterns that missed common spellings:
//   * 6to4 `/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})/` needed both groups written out,
//     so a zero second group compressed away was "public": 2002:a00:: (10.0.0.0) and
//     2002:c0a8:: (192.168.0.0), and 2002::1 (0.0.0.0) — exactly the forms the URL
//     parser and dns.lookup emit;
//   * NAT64 `/^64:ff9b:(?::)?X:Y$/` needed `::` and both trailing groups, so the
//     fully written 64:ff9b:0:0:0:0:a00:1 and the compressed 64:ff9b::1 were missed;
//   * IPv4-compatible `/^::X:Y$/` missed the fully written 0:0:0:0:0:0:a00:1.
// All three are now decoded from the eight groups. Pins, in every spelling
// (compressed, fully written, zero-padded, upper case, bracketed, zone suffix,
// dotted tail, URL-canonicalised):
//   * an embedded PRIVATE v4 is private;
//   * an embedded PUBLIC v4 stays allowed;
//   * only the exact prefixes are decoded, and malformed text never throws and
//     fails closed (reported private).

describe('isPrivateIpv6Address — 6to4 (2002::/16) embedding a private v4', () => {
    it.each([
        ['10.0.0.0, second group compressed away', '2002:a00::'],
        ['192.168.0.0, second group compressed away', '2002:c0a8::'],
        ['10.0.0.0 with an interface id', '2002:a00::1'],
        ['0.0.0.0, both groups compressed away', '2002::'],
        ['0.0.0.0 with an interface id', '2002::1'],
        ['10.0.0.1', '2002:a00:1::'],
        ['10.0.0.1 with a subnet and interface id', '2002:a00:1:1::1'],
        ['127.0.0.1 loopback', '2002:7f00:1::1'],
        ['169.254.169.254 cloud metadata', '2002:a9fe:a9fe::'],
        ['172.16.0.1', '2002:ac10:1::'],
        ['100.64.0.1 CGNAT', '2002:6440:1::'],
        ['fully written', '2002:a00:0:0:0:0:0:0'],
        ['fully written with an interface id', '2002:c0a8:1:0:0:0:0:1'],
        ['zero-padded', '2002:0a00:0000:0000:0000:0000:0000:0000'],
        ['upper case', '2002:C0A8::'],
        ['bracketed', '[2002:a00::]'],
        ['zone suffix', '2002:a00::%eth0'],
        ['a PUBLIC dotted tail cannot hide a private 6to4 prefix', '2002:a00:1::8.8.8.8'],
    ])('%s (%s) is private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(true);
    });

    it.each([
        ['[2002:0a00:0000:0000:0000:0000:0000:0000]', '[2002:a00::]'],
        ['[2002:C0A8:0:0:0:0:0:0]', '[2002:c0a8::]'],
        ['[2002:0:0:0:0:0:0:1]', '[2002::1]'],
        ['[2002:a00:1::8.8.8.8]', '[2002:a00:1::808:808]'],
    ])('the URL parser\'s canonical form of %s is private', (literal, canonical) => {
        // What reaches a guard is the WHATWG serialisation, not what was typed.
        const host = new URL(`https://${literal}/`).hostname;
        expect(host).toBe(canonical);
        expect(isPrivateIpv6Address(host)).toBe(true);
    });
});

describe('isPrivateIpv6Address — 6to4 embedding a public v4 stays allowed', () => {
    it.each([
        ['8.8.8.0, second group compressed away', '2002:808:800::'],
        ['8.8.8.8', '2002:808:808::'],
        ['93.184.216.34 with an interface id', '2002:5db8:d822::1'],
        ['172.32.0.1 (just outside 172.16/12)', '2002:ac20:1::'],
        ['fully written', '2002:808:808:0:0:0:0:1'],
        ['zero-padded', '2002:0808:0808:0000:0000:0000:0000:0000'],
        ['upper case, bracketed', '[2002:5DB8:D822::1]'],
        ['zone suffix', '2002:808:808::1%eth0'],
        ['public dotted tail', '2002:808:808::8.8.4.4'],
    ])('%s (%s) is not private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(false);
    });

    it('the URL parser\'s canonical form of a public 6to4 literal is not private', () => {
        const host = new URL('https://[2002:0808:0808:0000:0000:0000:0000:0001]/').hostname;
        expect(host).toBe('[2002:808:808::1]');
        expect(isPrivateIpv6Address(host)).toBe(false);
    });
});

describe('isPrivateIpv6Address — NAT64 (64:ff9b::/96) embedding a private v4', () => {
    it.each([
        ['10.0.0.1', '64:ff9b::a00:1'],
        ['192.168.0.1', '64:ff9b::c0a8:1'],
        ['127.0.0.1 loopback', '64:ff9b::7f00:1'],
        ['169.254.169.254 cloud metadata', '64:ff9b::a9fe:a9fe'],
        ['0.0.0.1, the high group compressed away', '64:ff9b::1'],
        ['0.0.0.0, the whole v4 compressed away', '64:ff9b::'],
        ['fully written', '64:ff9b:0:0:0:0:a00:1'],
        ['fully written 192.168.1.1', '64:ff9b:0:0:0:0:c0a8:101'],
        ['partly compressed', '64:ff9b:0::0:a00:1'],
        ['zero-padded', '0064:ff9b:0000:0000:0000:0000:0a00:0001'],
        ['upper case', '64:FF9B::A9FE:A9FE'],
        ['bracketed', '[64:ff9b:0:0:0:0:a00:1]'],
        ['zone suffix', '64:ff9b::a00:1%eth0'],
        ['dotted tail, fully written', '64:ff9b:0:0:0:0:10.0.0.1'],
    ])('%s (%s) is private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(true);
    });

    it.each([
        ['[64:ff9b:0:0:0:0:a00:1]', '[64:ff9b::a00:1]'],
        ['[0064:FF9B:0000:0000:0000:0000:0A00:0001]', '[64:ff9b::a00:1]'],
        ['[64:ff9b::0.0.0.1]', '[64:ff9b::1]'],
        ['[64:ff9b::169.254.169.254]', '[64:ff9b::a9fe:a9fe]'],
    ])('the URL parser\'s canonical form of %s is private', (literal, canonical) => {
        const host = new URL(`https://${literal}/`).hostname;
        expect(host).toBe(canonical);
        expect(isPrivateIpv6Address(host)).toBe(true);
    });
});

describe('isPrivateIpv6Address — NAT64 embedding a public v4 stays allowed', () => {
    it.each([
        ['8.8.8.8', '64:ff9b::808:808'],
        ['93.184.216.34', '64:ff9b::5db8:d822'],
        ['fully written 8.8.8.8', '64:ff9b:0:0:0:0:808:808'],
        ['zero-padded 1.1.1.1', '0064:ff9b:0000:0000:0000:0000:0101:0101'],
        ['upper case, bracketed', '[64:FF9B::5DB8:D822]'],
        ['zone suffix', '64:ff9b::808:808%eth0'],
        ['public dotted tail', '64:ff9b::8.8.8.8'],
    ])('%s (%s) is not private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(false);
    });

    it('the URL parser\'s canonical form of a public NAT64 literal is not private', () => {
        const host = new URL('https://[64:ff9b:0:0:0:0:8.8.8.8]/').hostname;
        expect(host).toBe('[64:ff9b::808:808]');
        expect(isPrivateIpv6Address(host)).toBe(false);
    });
});

describe('isPrivateIpv6Address — IPv4-compatible (::/96) in every spelling', () => {
    it.each([
        ['compressed 10.0.0.1', '::a00:1'],
        ['fully written 10.0.0.1', '0:0:0:0:0:0:a00:1'],
        ['zero-padded 192.168.0.1', '0000:0000:0000:0000:0000:0000:c0a8:0001'],
        ['bracketed, upper case 169.254.169.254', '[::A9FE:A9FE]'],
    ])('%s (%s) embedding a private v4 is private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(true);
    });

    it.each([
        ['compressed 8.8.8.8', '::808:808'],
        ['fully written 93.184.216.34', '0:0:0:0:0:0:5db8:d822'],
    ])('%s (%s) embedding a public v4 is not private', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(false);
    });

    it('the URL parser\'s canonical form of a fully written private literal is private', () => {
        const host = new URL('https://[0:0:0:0:0:0:a00:1]/').hostname;
        expect(host).toBe('[::a00:1]');
        expect(isPrivateIpv6Address(host)).toBe(true);
    });
});

describe('isPrivateIpv6Address — only the exact transition prefixes are decoded', () => {
    it.each([
        ['2003::/16 is not 6to4', '2003:a00:1::'],
        ['2002 in the second group is not 6to4', '2001:2002:a00:1::'],
        ['64:ff9a is not NAT64', '64:ff9a::a00:1'],
        ['65:ff9b is not NAT64', '65:ff9b::a00:1'],
        ['the NAT64 prefix shifted one group right', '0:64:ff9b::a00:1'],
        ['a non-zero group ahead of an IPv4-compatible tail', '0:0:0:0:0:1:a00:1'],
    ])('%s (%s) is not decoded as an embedded private v4', (_label, addr) => {
        expect(isPrivateIpv6Address(addr)).toBe(false);
    });
});

describe('isPrivateIpv6Address — malformed transition text fails closed and does not throw', () => {
    it.each([
        // Unparseable, so never decoded and never "public".
        ['6to4 with two :: compressions', '2002:a00::1::'],
        ['6to4 with a non-hex group', '2002:a00:zz::'],
        ['NAT64 with two :: compressions', '64:ff9b::a00::1'],
        ['NAT64 with seven groups, no compression', '64:ff9b:0:0:0:a00:1'],
        // Would read as the PUBLIC 6to4 of 8.8.8.8 if the parser ignored the extra ::.
        ['6to4 of a public v4 with two :: compressions', '2002:808:808::1::'],
    ])('%s (%s) is refused', (_label, addr) => {
        expect(() => isPrivateIpv6Address(addr)).not.toThrow();
        expect(isPrivateIpv6Address(addr)).toBe(true);
    });
});
