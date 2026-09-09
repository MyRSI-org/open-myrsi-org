import { describe, it, expect } from 'vitest';
import { escapeLikePattern } from '../lib/pgrest';
import { isPrivateIpv6Address, isPrivateIpv4 } from '../lib/linkUrl';

// fed-peer-1 / injection-1: LIKE metacharacters in an externally-supplied value
// must be escaped so '%' can't become a match-everything wildcard.
describe('escapeLikePattern', () => {
    it("escapes %, _, backslash and PostgREST's * alias", () => {
        expect(escapeLikePattern('%')).toBe('\\%');
        expect(escapeLikePattern('a_b')).toBe('a\\_b');
        expect(escapeLikePattern('x\\y')).toBe('x\\\\y');
        expect(escapeLikePattern('100%_off\\')).toBe('100\\%\\_off\\\\');
        // PostgREST rewrites `*` to `%` in a like/ilike operand before Postgres
        // sees it, so escaping %/_/\ alone still shipped a live wildcard.
        expect(escapeLikePattern('*')).toBe('\\*');
        // Combined: fails if ANY one of the four is dropped from the class.
        expect(escapeLikePattern('a%b_c\\d*e')).toBe('a\\%b\\_c\\\\d\\*e');
    });
    it('leaves a clean value unchanged and handles non-strings', () => {
        expect(escapeLikePattern('Org-Name 1')).toBe('Org-Name 1');
        expect(escapeLikePattern('')).toBe('');
        expect(escapeLikePattern(null)).toBe('');
        expect(escapeLikePattern(123)).toBe('');
    });
});

// ssrf-1: the IPv6 private-range check must also catch the transition ranges
// (NAT64 / 6to4 / IPv4-compatible) that embed a private IPv4 destination.
describe('isPrivateIpv6Address transition ranges', () => {
    it('still catches the classic private ranges', () => {
        expect(isPrivateIpv6Address('::1')).toBe(true);
        expect(isPrivateIpv6Address('fe80::1')).toBe(true);
        expect(isPrivateIpv6Address('fc00::1')).toBe(true);
        expect(isPrivateIpv6Address('::ffff:10.0.0.1')).toBe(true);
    });
    it('catches NAT64 64:ff9b::/96 wrapping a private v4 (hex + dotted)', () => {
        expect(isPrivateIpv6Address('64:ff9b::a00:1')).toBe(true);       // 10.0.0.1
        expect(isPrivateIpv6Address('64:ff9b::10.0.0.1')).toBe(true);
        expect(isPrivateIpv6Address('64:ff9b::7f00:1')).toBe(true);      // 127.0.0.1
    });
    it('catches 6to4 2002::/16 wrapping a private v4', () => {
        expect(isPrivateIpv6Address('2002:0a00:0001::')).toBe(true);     // 10.0.0.1
        expect(isPrivateIpv6Address('2002:c0a8:0001::')).toBe(true);     // 192.168.0.1
    });
    it('catches IPv4-compatible ::a.b.c.d wrapping a private v4', () => {
        expect(isPrivateIpv6Address('::7f00:1')).toBe(true);             // 127.0.0.1
        expect(isPrivateIpv6Address('::a00:1')).toBe(true);             // 10.0.0.1
    });
    it('does NOT flag a global-unicast address or a public embedded v4', () => {
        expect(isPrivateIpv6Address('2606:4700:4700::1111')).toBe(false); // Cloudflare DNS
        expect(isPrivateIpv6Address('64:ff9b::808:808')).toBe(false);     // 8.8.8.8 (public)
        expect(isPrivateIpv4('8.8.8.8')).toBe(false);
    });
});
