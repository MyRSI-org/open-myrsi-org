import { describe, it, expect } from 'vitest';
import { normalizeEmbedSrc, isAllowedIframeSrc, ALLOWED_IFRAME_HOSTS, YOUTUBE_EMBED_HOST } from '../lib/embedHosts';

// normalizeEmbedSrc runs IN FRONT of the embed host allow-list at the write
// boundary (lib/tiptapValidate sanitizeNode), so it is itself a security surface:
// if it could be steered to emit a non-YouTube origin, it would BE the allow-list
// bypass. These tests pin both halves of the contract — the rescue (a pasted share
// link is rewritten instead of being deleted on save) and the invariant that the
// output is always either null or a hard-coded nocookie /embed/ URL.

const ID = 'dQw4w9WgXcQ';               // canonical 11-char video id
const EMBED = `https://${YOUTUBE_EMBED_HOST}/embed/${ID}`;

describe('normalizeEmbedSrc — share-link shapes that used to be deleted on save', () => {
    it('rewrites a youtu.be short link', () => {
        expect(normalizeEmbedSrc(`https://youtu.be/${ID}`)).toBe(EMBED);
    });

    it('rewrites the exact URL the YouTube Share button produces (?si= tracking param)', () => {
        expect(normalizeEmbedSrc(`https://youtu.be/${ID}?si=AbCdEfGhIjKl`)).toBe(EMBED);
    });

    it('rewrites a bare youtube.com/watch link (no www)', () => {
        expect(normalizeEmbedSrc(`https://youtube.com/watch?v=${ID}`)).toBe(EMBED);
    });

    it('rewrites the mobile and music hosts', () => {
        expect(normalizeEmbedSrc(`https://m.youtube.com/watch?v=${ID}`)).toBe(EMBED);
        expect(normalizeEmbedSrc(`https://music.youtube.com/watch?v=${ID}`)).toBe(EMBED);
    });

    it('rewrites the /shorts/, /live/ and /v/ path shapes', () => {
        expect(normalizeEmbedSrc(`https://www.youtube.com/shorts/${ID}`)).toBe(EMBED);
        expect(normalizeEmbedSrc(`https://www.youtube.com/live/${ID}`)).toBe(EMBED);
        expect(normalizeEmbedSrc(`https://www.youtube.com/v/${ID}`)).toBe(EMBED);
    });

    it('preserves a timestamp so normalising cannot silently move the start point', () => {
        expect(normalizeEmbedSrc(`https://youtu.be/${ID}?t=90`)).toBe(`${EMBED}?start=90`);
        expect(normalizeEmbedSrc(`https://youtu.be/${ID}?t=90s`)).toBe(`${EMBED}?start=90`);
        expect(normalizeEmbedSrc(`https://youtu.be/${ID}?start=90`)).toBe(`${EMBED}?start=90`);
    });

    it('ignores a non-numeric or zero timestamp rather than emitting a broken param', () => {
        expect(normalizeEmbedSrc(`https://youtu.be/${ID}?t=abc`)).toBe(EMBED);
        expect(normalizeEmbedSrc(`https://youtu.be/${ID}?t=0`)).toBe(EMBED);
    });
});

describe('normalizeEmbedSrc — abstains rather than damaging the URL', () => {
    it('never upgrades http to https (that would WIDEN the allow-list, not fix it)', () => {
        expect(normalizeEmbedSrc(`http://youtu.be/${ID}`)).toBeNull();
        expect(normalizeEmbedSrc(`http://www.youtube.com/watch?v=${ID}`)).toBeNull();
    });

    it('leaves an /embed/ URL carrying foreign params alone — rewriting would drop them', () => {
        expect(normalizeEmbedSrc(`https://www.youtube.com/embed/${ID}?list=PLabc&rel=0`)).toBeNull();
        expect(normalizeEmbedSrc(`https://www.youtube.com/embed/${ID}?index=2`)).toBeNull();
    });

    it('still upgrades an /embed/ URL whose only params are reproducible', () => {
        expect(normalizeEmbedSrc(`https://www.youtube.com/embed/${ID}`)).toBe(EMBED);
        expect(normalizeEmbedSrc(`https://www.youtube.com/embed/${ID}?start=30`)).toBe(`${EMBED}?start=30`);
    });

    it('leaves the reserved videoseries / live_stream segments alone (11 chars, but not ids)', () => {
        expect(normalizeEmbedSrc('https://www.youtube.com/embed/videoseries?list=PLabc')).toBeNull();
        expect(normalizeEmbedSrc('https://www.youtube.com/embed/live_stream?channel=UCabc')).toBeNull();
    });

    it('abstains on YouTube URLs that carry no video id', () => {
        expect(normalizeEmbedSrc('https://www.youtube.com/playlist?list=PLabc')).toBeNull();
        expect(normalizeEmbedSrc('https://www.youtube.com/@channel')).toBeNull();
        expect(normalizeEmbedSrc('https://www.youtube.com/watch?v=short')).toBeNull();
    });

    it('abstains on non-URL, non-string and empty input', () => {
        expect(normalizeEmbedSrc('not a url')).toBeNull();
        expect(normalizeEmbedSrc('')).toBeNull();
        expect(normalizeEmbedSrc(null)).toBeNull();
        expect(normalizeEmbedSrc(undefined)).toBeNull();
        expect(normalizeEmbedSrc(42)).toBeNull();
        expect(normalizeEmbedSrc({ toString: () => `https://youtu.be/${ID}` })).toBeNull();
    });

    it('KNOWN GAP (shared with hosted): a trailing slash defeats the id match', () => {
        // Documented rather than fixed — tightening the id extraction changes the
        // security-critical half of the function and needs its own item.
        expect(normalizeEmbedSrc(`https://youtu.be/${ID}/`)).toBeNull();
    });
});

describe('normalizeEmbedSrc — cannot itself become the allow-list bypass', () => {
    it('matches the hostname by EQUALITY, never as a substring', () => {
        expect(normalizeEmbedSrc(`https://www.youtube.com.evil.example/watch?v=${ID}`)).toBeNull();
        expect(normalizeEmbedSrc(`https://youtu.be.evil.example/${ID}`)).toBeNull();
        expect(normalizeEmbedSrc(`https://evil.example/?x=https://youtu.be/${ID}`)).toBeNull();
        expect(normalizeEmbedSrc(`https://evil.example/watch?v=${ID}`)).toBeNull();
    });

    it('is not fooled by userinfo — the hostname parses to the attacker host', () => {
        expect(normalizeEmbedSrc(`https://www.youtube.com@evil.example/watch?v=${ID}`)).toBeNull();
        expect(normalizeEmbedSrc(`https://youtu.be@evil.example/${ID}`)).toBeNull();
    });

    it('rejects a path that is not a bare 11-char id', () => {
        expect(normalizeEmbedSrc('https://youtu.be/../../evil')).toBeNull();   // parser collapses to /evil
        expect(normalizeEmbedSrc('https://youtu.be/abc/def')).toBeNull();
        expect(normalizeEmbedSrc(`https://youtu.be/${ID}#@evil.example`)).toBe(EMBED);
    });

    it('INVARIANT: every input yields null or a hard-coded nocookie /embed/ URL', () => {
        const hostile = [
            'javascript:alert(1)//youtu.be/dQw4w9WgXcQ',
            'data:text/html,<script>1</script>',
            'vbscript:msgbox',
            'file:///etc/passwd',
            '//youtu.be/dQw4w9WgXcQ',
            `https://www.youtube.com.evil.example/watch?v=${ID}`,
            `https://www.youtube.com@evil.example/watch?v=${ID}`,
            `https://evil.example/?u=https://www.youtube.com/watch?v=${ID}`,
            'https://youtu.be/%2E%2E%2F%2E%2E%2Fevil',
            'https://youtu.be/aaaaaaaaaaa/../../../evil',
            'https://youtu.be/aaaaaaaaaaa?next=https://evil.example',
            'https://www.youtube.com/watch?v=aaaaaaaaaaa&v=evil',
            'https://www.youtube.com/watch?v=../../evil',
            'https://www.youtube.com/embed/aaaaaaaaaaa"><script>1</script>',
            "https://www.youtube.com/embed/aaaaaaaaaaa'onload='alert(1)",
            'https://xn--youtube-2m4d.com/watch?v=aaaaaaaaaaa',
            'https://YOUTU.BE/aaaaaaaaaaa',
            'https://youtu.be:8443/aaaaaaaaaaa',
            'https://youtu.be/aaaaaaaaaaa?start=999999999999',
            'https://music.youtube.com/watch?v=aaaaaaaaaaa&list=PL',
        ];
        for (const input of hostile) {
            const out = normalizeEmbedSrc(input);
            expect(out === null || out.startsWith(`https://${YOUTUBE_EMBED_HOST}/embed/`)).toBe(true);
            // Whatever comes back must survive the allow-list it is about to face.
            if (out !== null) expect(isAllowedIframeSrc(out)).toBe(true);
        }
    });

    it('the emitted host is itself allow-listed (the whole rescue depends on it)', () => {
        expect(ALLOWED_IFRAME_HOSTS).toContain(YOUTUBE_EMBED_HOST);
        expect(isAllowedIframeSrc(EMBED)).toBe(true);
    });
});
