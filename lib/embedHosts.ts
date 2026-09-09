// Single source of truth for which iframe/embed hosts rich content may reference.
//
// Used by the Academy CoursePlayer (components/views/academy/CoursePlayer.tsx) to
// decide whether a lesson's YouTube/Vimeo URL may be embedded in an <iframe> vs
// linked out. MUST stay aligned with the CSP `frame-src` directive in server.ts
// (an embed allowed here but missing from frame-src would be blocked by the
// browser). lib/tiptapValidate imports this list to enforce it at the WRITE
// boundary, so the editor and the sanitizer can never drift apart.
//
// Matching is on the parsed URL hostname (exact or dotted-suffix), NEVER a
// substring, so `youtube.com.evil.example` and `evil.example/?x=youtube.com`
// are both rejected.

export const ALLOWED_IFRAME_HOSTS = [
    'www.youtube.com',
    'www.youtube-nocookie.com',
    'player.vimeo.com',
    'docs.google.com',
    'drive.google.com',
    'calendar.google.com',
    'www.google.com',
    'open.spotify.com',
    'codepen.io',
    'stackblitz.com',
] as const;

export function isAllowedIframeSrc(src: unknown): boolean {
    if (typeof src !== 'string' || !src) return false;
    try {
        const url = new URL(src);
        if (url.protocol !== 'https:') return false;
        return ALLOWED_IFRAME_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// YouTube share-link normalisation
// ---------------------------------------------------------------------------
// Tiptap's Youtube extension stores the URL exactly as PASTED; only the browser
// render path rewrites it into an embed URL. So `youtu.be/ID` — precisely what the
// YouTube Share button produces — plus bare `youtube.com/watch?v=ID` and
// `m.`/`music.youtube.com` are absent from ALLOWED_IFRAME_HOSTS, and the write-
// boundary sanitiser DELETED the node on save. The author pasted a share link, the
// toolbar accepted it, the editor played the video, and it was silently gone
// afterwards — on wiki pages, government legislation and the wiki home blurb alike.
//
// Normalising a recognised share link to its canonical embed URL fixes that. No
// backfill migration is needed or possible: a share link never reached storage in
// the first place (it was dropped), and every src that IS stored is already
// allow-listed and therefore never rewritten — see the caller in lib/tiptapValidate.
//
// SECURITY — the caller runs this IN FRONT of isAllowedIframeSrc, so a sloppy
// normaliser would itself BE the bypass. Two properties make that impossible:
//
//  1. Dispatch is on the PARSED url.hostname compared by EQUALITY against a fixed
//     set — never a substring test. `evil.example/?x=youtube.com`,
//     `www.youtube.com.evil.example` and `https://www.youtube.com@evil.example/x`
//     all resolve to a hostname that is not in the set and are left untouched.
//  2. The output is BUILT, not edited: a hard-coded scheme, host and path plus a
//     video id validated against /^[A-Za-z0-9_-]{11}$/. That charset contains no
//     '/', '?', '#', ':' or '.', so no input can steer the result to another origin.
//
// Anything not recognised is returned as null and the caller falls back to the
// original src, which still faces the allowlist exactly as before. Normalisation
// only ever converts an already-YouTube URL into a different YouTube URL.

/** Hosts whose YouTube share links we recognise. Compared by EQUALITY, never substring. */
const YOUTUBE_WATCH_HOSTS = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com',
]);

/** youtu.be carries the id as the whole path and serves no embeds itself. */
const YOUTUBE_SHORT_HOST = 'youtu.be';

/** YouTube video ids are exactly 11 chars from this alphabet. */
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** /embed/ID, /shorts/ID, /live/ID, /v/ID — the id-bearing path shapes. */
const YOUTUBE_PATH_ID_RE = /^\/(?:embed|shorts|live|v)\/([^/?#]+)$/;

/**
 * The single host we emit. Matches `Youtube.configure({ nocookie: true })` in
 * WikiEditor, and is present in BOTH ALLOWED_IFRAME_HOSTS above and the CSP
 * `frame-src` directive in server.ts.
 */
export const YOUTUBE_EMBED_HOST = 'www.youtube-nocookie.com';

/** `?t=90`, `?t=90s` or `?start=90` — preserved so normalising cannot silently move a timestamp. */
function youtubeStartSeconds(url: URL): number | null {
    const raw = url.searchParams.get('start') ?? url.searchParams.get('t');
    if (raw === null) return null;
    const match = /^(\d{1,6})s?$/.exec(raw.trim());
    if (!match) return null;
    const seconds = Number(match[1]);
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

/**
 * Rewrite a recognised YouTube share link to its canonical embed URL.
 * Returns null for everything else — including non-https, unrecognised hosts, and
 * YouTube URLs with no video id (a playlist or channel page) — so callers fall back
 * to the original src and the allowlist decides, exactly as before.
 *
 * http is deliberately NOT upgraded to https: doing so would let a plaintext URL
 * enter the allowlist, which is a widening, not a fix.
 *
 * KNOWN GAP (shared with the hosted build, deliberately not fixed here): a trailing
 * slash — `https://youtu.be/ID/` — leaves 'ID/' as the path segment, which fails
 * YOUTUBE_ID_RE, so that shape is still dropped. Tightening the id extraction is a
 * behaviour change to the security-critical half of this function; it needs its own
 * item, not a drive-by.
 */
export function normalizeEmbedSrc(src: unknown): string | null {
    if (typeof src !== 'string' || !src) return null;

    let url: URL;
    try {
        url = new URL(src);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:') return null;

    let videoId: string | null = null;
    if (url.hostname === YOUTUBE_SHORT_HOST) {
        const segment = url.pathname.slice(1);
        if (YOUTUBE_ID_RE.test(segment)) videoId = segment;
    } else if (YOUTUBE_WATCH_HOSTS.has(url.hostname)) {
        if (url.pathname === '/watch') {
            const v = url.searchParams.get('v');
            if (v && YOUTUBE_ID_RE.test(v)) videoId = v;
        } else {
            const match = YOUTUBE_PATH_ID_RE.exec(url.pathname);
            if (match && YOUTUBE_ID_RE.test(match[1])) videoId = match[1];
        }
    }
    if (!videoId) return null;

    // 'videoseries' (playlist embeds) and 'live_stream' (channel live embeds) are
    // RESERVED path segments, not video ids — and by an unhappy coincidence BOTH are
    // exactly 11 characters drawn from the id alphabet, so they sail straight through
    // YOUTUBE_ID_RE. Rebuilding them discards the ?list=/?channel= that gives them
    // meaning and produces a URL YouTube serves as an error. They are already
    // allowlisted, so hand them back untouched.
    if (videoId === 'videoseries' || videoId === 'live_stream') return null;

    // An /embed/ URL is ALREADY an embed: it is allowlisted as it stands, and the only
    // thing rewriting it can achieve is the nocookie upgrade — at the cost of dropping
    // every embed parameter the author set (list, index, loop, playlist, rel,
    // cc_load_policy, …), because this function re-emits nothing but the timestamp. So
    // only rewrite one when there is demonstrably nothing to lose.
    if (url.pathname.startsWith('/embed/')) {
        for (const key of url.searchParams.keys()) {
            if (key !== 'start' && key !== 't') return null;
        }
    }

    const start = youtubeStartSeconds(url);
    return `https://${YOUTUBE_EMBED_HOST}/embed/${videoId}${start ? `?start=${start}` : ''}`;
}
