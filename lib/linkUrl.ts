// Validators for user-supplied outbound link URLs (things we'll render as
// <a href="…"> on public pages). These are hyperlinks, not image sources, so
// the rules are different from lib/imageUrl.ts — any content type is OK, but
// the host must be a public internet address and the scheme must be one we
// explicitly allow.
//
// We reject localhost and private/reserved IP ranges to prevent a tenant
// admin from tricking a support agent who opens the org's public page into
// probing internal network resources from their browser.

const MAX_LEN = 500;
const ALLOWED_SCHEMES = new Set(['https:', 'discord:']);

// IPv4 private/reserved ranges we block. RFC 1918 + loopback + link-local
// + CGNAT + multicast + broadcast + reserved, and every other entry of the IANA
// IPv4 Special-Purpose Address Registry that is not globally reachable
// (documentation, benchmarking, protocol assignments, the 6to4 relay anycast).
// Matched against a validated dotted quad (see isPrivateIpv4), so a prefix
// ending in `\.` is an exact octet match.
const IPV4_BLOCKLIST = [
    /^0\./,                    // 0.0.0.0/8
    /^10\./,                   // 10.0.0.0/8  (RFC 1918)
    /^127\./,                  // 127.0.0.0/8 loopback
    /^169\.254\./,             // 169.254.0.0/16 link-local
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12 (RFC 1918)
    /^192\.168\./,             // 192.168.0.0/16 (RFC 1918)
    /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./, // 100.64.0.0/10 CGNAT
    /^192\.0\.0\./,            // 192.0.0.0/24 IETF protocol assignments (RFC 6890)
    /^192\.0\.2\./,            // 192.0.2.0/24 documentation, TEST-NET-1 (RFC 5737)
    /^192\.88\.99\./,          // 192.88.99.0/24 deprecated 6to4 relay anycast (RFC 7526)
    /^198\.1[89]\./,           // 198.18.0.0/15 benchmarking (RFC 2544)
    /^198\.51\.100\./,         // 198.51.100.0/24 documentation, TEST-NET-2 (RFC 5737)
    /^203\.0\.113\./,          // 203.0.113.0/24 documentation, TEST-NET-3 (RFC 5737)
    /^22[4-9]\./,              // 224.0.0.0/4 multicast
    /^23[0-9]\./,              // 224.0.0.0/4 multicast continued
    /^2[4-5][0-9]\./,          // 240.0.0.0/4 reserved + broadcast
];

// One decimal octet, 0-255, with no leading zero: the only spelling dns.lookup,
// the WHATWG URL serialiser and dottedIpv4() produce. A leading zero is octal to
// inet_aton (010 is 8), so such an address has no single destination.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const DOTTED_QUAD = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`);

function isIpv4(host: string): boolean {
    return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * True for an IPv4 address that must not be reached (IPV4_BLOCKLIST). Fails
 * closed: anything that is not a well-formed dotted quad (an octet over 255, a
 * leading zero, a missing or extra octet, surrounding text) is never "public".
 */
export function isPrivateIpv4(host: string): boolean {
    if (!DOTTED_QUAD.test(host)) return true;
    return IPV4_BLOCKLIST.some(re => re.test(host));
}

/**
 * The eight 16-bit groups of an IPv6 address, or null when it is not one. Accepts
 * every spelling an address can arrive in: `::`-compressed or fully written out,
 * zero-padded groups, and a trailing dotted IPv4 tail. Expects lower case with
 * brackets already removed; a zone suffix (`%eth0`) is ignored.
 */
function ipv6Groups(addr: string): number[] | null {
    let s = addr.replace(/%.*$/, '');
    const tail = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (tail) {
        const o = tail.slice(2).map(Number);
        if (o.some((n) => n > 255)) return null;
        s = `${tail[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const parse = (part: string): number[] | null => {
        if (part === '') return [];
        const out: number[] = [];
        for (const g of part.split(':')) {
            if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
            out.push(parseInt(g, 16));
        }
        return out;
    };
    const head = parse(halves[0]);
    const rest = halves.length === 2 ? parse(halves[1]) : [];
    if (!head || !rest) return null;
    if (halves.length === 1) return head.length === 8 ? head : null;
    const zeros = 8 - head.length - rest.length;
    if (zeros < 1) return null;
    return [...head, ...new Array<number>(zeros).fill(0), ...rest];
}

/** Dotted form of the IPv4 address held in two 16-bit groups. */
function dottedIpv4(hi: number, lo: number): string {
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * The IPv4 address an IPv6 address carries by a transition mechanism, in any
 * spelling, or null for any other address:
 *   - IPv4-mapped ::ffff:0:0/96 (`::ffff:X:Y`), IPv4-translated ::ffff:0:0:0/96
 *     (`::ffff:0:X:Y`, RFC 2765), IPv4-compatible ::/96 (`::X:Y`) and NAT64
 *     64:ff9b::/96 (RFC 6052): the trailing 32 bits, groups 6-7;
 *   - 6to4 2002::/16 (RFC 3056): the 32 bits after the prefix, groups 1-2.
 * Decoded from the eight groups, never matched as text: WHATWG URL serialises a
 * mapped literal in HEX (`[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`), and a
 * zero group compresses away, so 6to4 of 10.0.0.0 arrives as `2002:a00::` and
 * NAT64 of 0.0.0.1 as `64:ff9b::1`. A dual-stack socket, a 6to4 relay or a NAT64
 * gateway delivers to the embedded IPv4 address, so that is the one to classify.
 * Takes the groups from ipv6Groups().
 */
function embeddedIpv4(g: readonly number[]): string | null {
    if (g[0] === 0x2002) return dottedIpv4(g[1], g[2]);
    const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
    const mapped = zero(0, 5) && g[5] === 0xffff;
    const translated = zero(0, 4) && g[4] === 0xffff && g[5] === 0;
    const compatible = zero(0, 6);
    const nat64 = g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6);
    return mapped || translated || compatible || nat64 ? dottedIpv4(g[6], g[7]) : null;
}

/**
 * IPv6 special-purpose prefixes that are not globally reachable (IANA IPv6
 * Special-Purpose Address Registry, plus site-local and multicast from the IPv6
 * Address Space registry). Matched on the eight groups, never on text, so every
 * spelling of an address counts. Each is refused WHOLE: nothing inside is decoded,
 * so an embedded "public" IPv4 cannot rescue an address in one of them.
 */
const IPV6_NON_PUBLIC_PREFIXES: ReadonlyArray<(g: readonly number[]) => boolean> = [
    (g) => g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0x1,        // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
    (g) => g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0, // 100::/64 discard-only (RFC 6666)
    (g) => g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 1, // 100:0:0:1::/64 dummy prefix (RFC 9780)
    // 2001::/23 IETF protocol assignments (RFC 2928): Teredo 2001::/32, the PCP /
    // TURN / DNS-SD SRP anycasts, benchmarking 2001:2::/48, AMT, AS112, ORCHID and
    // ORCHIDv2, DRIP. Ends at 2001:1ff:ffff:…; 2001:200:: onwards is ordinary
    // global unicast.
    (g) => g[0] === 0x2001 && g[1] < 0x200,
    (g) => g[0] === 0x2001 && g[1] === 0xdb8,                        // 2001:db8::/32 documentation (RFC 3849)
    (g) => g[0] === 0x3fff && g[1] < 0x1000,                         // 3fff::/20 documentation (RFC 9637)
    (g) => g[0] === 0x5f00,                                          // 5f00::/16 SRv6 SIDs (RFC 9602)
    (g) => (g[0] & 0xffc0) === 0xfec0,                               // fec0::/10 site-local, deprecated (RFC 3879)
    (g) => (g[0] & 0xff00) === 0xff00,                               // ff00::/8 multicast
];

/**
 * True for IPv6 addresses that must not be reached by server-side fetches:
 * loopback (::1), unspecified (::), link-local (fe80::/10), unique-local
 * (fc00::/7), every prefix in IPV6_NON_PUBLIC_PREFIXES, IPv4-mapped
 * (::ffff:a.b.c.d, and its hex form ::ffff:X:Y), IPv4-translated (::ffff:0:X:Y),
 * and the transition ranges that embed an IPv4 destination — NAT64
 * (64:ff9b::/96), 6to4 (2002::/16), and IPv4-compatible (::a.b.c.d) — when the
 * embedded v4 is private, in any spelling (see embeddedIpv4). An address
 * embedding a PUBLIC v4 is not private. Fails closed: text that does not parse
 * as an IPv6 address is never "public". Used by the SSRF DNS-resolution guard
 * (lib/ssrf.ts).
 */
export function isPrivateIpv6Address(addr: string): boolean {
    const a = addr.toLowerCase().replace(/^\[|\]$/g, '');
    if (a === '::1' || a === '::') return true;
    if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true; // fe80::/10
    if (a.startsWith('fc') || a.startsWith('fd')) return true; // fc00::/7 unique-local

    // Any DOTTED embedded v4 (covers ::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4).
    const dotted = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (dotted && isPrivateIpv4(dotted[1])) return true;

    const groups = ipv6Groups(a);
    if (!groups) return true;
    if (IPV6_NON_PUBLIC_PREFIXES.some((inPrefix) => inPrefix(groups))) return true;

    // Every transition form — mapped, translated, compatible, NAT64, 6to4 — decoded
    // from the groups, so hex, compressed and fully written spellings all count.
    const v4 = embeddedIpv4(groups);
    return v4 !== null && isPrivateIpv4(v4);
}

function isIpv6(host: string): boolean {
    // Bracketed form when hostname came from URL.
    const stripped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    return stripped.includes(':');
}

/**
 * Validate an outbound public link URL. Returns the trimmed URL on success,
 * or null if it should be rejected. discord:// URIs are permitted unchecked
 * (the scheme itself is not web-reachable).
 */
export function sanitizePublicLinkUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > MAX_LEN) return null;

    let parsed: URL;
    try { parsed = new URL(trimmed); } catch { return null; }

    if (!ALLOWED_SCHEMES.has(parsed.protocol)) return null;
    if (parsed.protocol === 'discord:') return parsed.toString();

    if (parsed.username || parsed.password) return null;

    const host = parsed.hostname.toLowerCase();
    if (!host) return null;

    // Block obvious local hostnames.
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return null;
    // Block internal-looking mDNS/.local names.
    if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.intranet')) return null;

    // Block IPv6 literals outright — hard to enumerate all reserved ranges
    // and there's no real user need for IPv6 literal links in a public page.
    if (isIpv6(host)) return null;

    // Block reserved IPv4 ranges.
    if (isIpv4(host) && isPrivateIpv4(host)) return null;

    return parsed.toString();
}
