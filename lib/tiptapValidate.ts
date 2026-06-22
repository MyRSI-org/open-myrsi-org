// Pure Tiptap-JSON sanitizer + safe-HTML emitter.
//
// Two responsibilities, both implemented as recursive walks over the JSON
// document the editor produces. NO Tiptap dependency, NO DOM dependency —
// runs equally well in Node and the browser.
//
// 1. sanitizeTiptapJson: drops disallowed nodes/marks, strips javascript:/
//    data: URLs from links and embeds. Defense in depth for save paths so
//    a malicious or buggy client can't store dangerous content.
//
// 2. tiptapJsonToSafeHtml: converts a sanitized doc to HTML. The walker
//    only emits known-safe tags and HTML-escapes every text node, so the
//    output is XSS-safe by construction. Used by the public landing-page
//    blurb render path which mounts the result via dangerouslySetInnerHTML.
//
// Allowlists differ by mode so the same helpers serve both the rich wiki
// surface and the constrained public blurb.

export type TiptapValidatorMode = 'wiki' | 'minimal';

// ---------------------------------------------------------------------------
// Recursion depth cap (DoS guard)
// ---------------------------------------------------------------------------
// Every walk over the JSON document (sanitize / emit / empty-detect) is
// recursive. A hostile author could post a deeply-nested doc (~10k levels, well
// under 1MB) and exhaust the stack. Real documents nest only a handful of levels
// (lists-in-lists, tables, blockquotes), so a generous ceiling is invisible to
// legitimate content; at the cap we stop descending and drop/truncate the
// subtree (fail closed).
const MAX_DEPTH = 100;

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

interface AllowConfig {
    nodes: Set<string>;
    marks: Set<string>;
    // Mark/node attrs by type → which keys are kept. Anything not listed
    // gets stripped before storage.
    allowedAttrs: Record<string, string[]>;
}

const WIKI_ALLOW: AllowConfig = {
    nodes: new Set([
        'doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem',
        'blockquote', 'codeBlock', 'horizontalRule', 'image', 'hardBreak',
        'table', 'tableRow', 'tableCell', 'tableHeader', 'youtube', 'iframe',
        'text',
    ]),
    marks: new Set(['bold', 'italic', 'underline', 'strike', 'code', 'link', 'textAlign']),
    allowedAttrs: {
        heading: ['level', 'textAlign'],
        paragraph: ['textAlign'],
        codeBlock: ['language'],
        image: ['src', 'alt', 'title'],
        link: ['href', 'target', 'rel'],
        youtube: ['src', 'width', 'height'],
        iframe: ['src', 'width', 'height'],
        tableCell: ['colspan', 'rowspan', 'colwidth'],
        tableHeader: ['colspan', 'rowspan', 'colwidth'],
        textAlign: ['align'],
    },
};

const MINIMAL_ALLOW: AllowConfig = {
    nodes: new Set([
        'doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem',
        'hardBreak', 'text',
    ]),
    marks: new Set(['bold', 'italic', 'link']),
    allowedAttrs: {
        heading: ['level'],
        link: ['href', 'target', 'rel'],
    },
};

const ALLOW: Record<TiptapValidatorMode, AllowConfig> = { wiki: WIKI_ALLOW, minimal: MINIMAL_ALLOW };

// ---------------------------------------------------------------------------
// URL scheme guard
// ---------------------------------------------------------------------------
// Allow http(s) absolute URLs, mailto: (links only), and root-relative paths.
// Reject javascript:, data:, vbscript:, file:, anything else.
// Returns null if the URL is unsafe — callers should drop the surrounding
// node/mark when null is returned.

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function safeUrl(raw: unknown, opts: { allowMailto?: boolean } = {}): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Root-relative paths are always safe (and useful for inter-org links)
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
    // Try as absolute URL
    try {
        const u = new URL(trimmed);
        if (!SAFE_SCHEMES.has(u.protocol)) return null;
        if (u.protocol === 'mailto:' && !opts.allowMailto) return null;
        return u.href;
    } catch {
        return null;
    }
}

// Embed host allow-list — the SAME hosts the CSP frame-src permits and the client
// wiki IframeExtension renders. Enforced at the WRITE boundary (sanitizeNode) so an
// off-allowlist iframe/youtube src never reaches storage, rather than relying only
// on the client render check + CSP frame-src downstream. Kept here (isomorphic,
// dependency-free) as the single source of truth; the client extension imports it.
// KEEP IN SYNC with the CSP frame-src directive in server.ts. (api-1/fe-3)
export const ALLOWED_EMBED_HOSTS = [
    'www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com',
    'docs.google.com', 'drive.google.com', 'calendar.google.com', 'www.google.com',
    'open.spotify.com', 'codepen.io', 'stackblitz.com',
];
export function isAllowedEmbedHost(src: string | null | undefined): boolean {
    if (!src) return false;
    try {
        const u = new URL(src);
        if (u.protocol !== 'https:') return false;
        return ALLOWED_EMBED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------

function sanitizeAttrs(type: string, attrs: any, cfg: AllowConfig): any | undefined {
    if (!attrs || typeof attrs !== 'object') return undefined;
    const allowed = cfg.allowedAttrs[type];
    if (!allowed) return undefined;
    const out: any = {};
    for (const key of allowed) {
        if (attrs[key] !== undefined && attrs[key] !== null) out[key] = attrs[key];
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeMark(mark: any, cfg: AllowConfig): any | null {
    if (!mark || typeof mark !== 'object' || typeof mark.type !== 'string') return null;
    if (!cfg.marks.has(mark.type)) return null;
    const cleanAttrs = sanitizeAttrs(mark.type, mark.attrs, cfg);
    if (mark.type === 'link') {
        const href = safeUrl(cleanAttrs?.href, { allowMailto: true });
        if (!href) return null;
        return { type: 'link', attrs: { href, target: '_blank', rel: 'noopener noreferrer' } };
    }
    return cleanAttrs ? { type: mark.type, attrs: cleanAttrs } : { type: mark.type };
}

function sanitizeNode(node: any, cfg: AllowConfig, depth = 0): any | null {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return null;
    if (!cfg.nodes.has(node.type)) return null;
    // Depth cap: at the ceiling, drop the subtree entirely (fail closed)
    // rather than recursing further and risking stack exhaustion.
    if (depth > MAX_DEPTH) return null;

    // URL-bearing nodes: drop if the URL is unsafe.
    if (node.type === 'image' || node.type === 'youtube' || node.type === 'iframe') {
        const src = safeUrl(node.attrs?.src);
        if (!src) return null;
        // iframe/youtube embeds must additionally point at an allow-listed host
        // (parity with CSP frame-src + the client render check), enforced at the
        // write boundary. Images are scheme-checked only — any https image host is
        // fine (img-src allows https:).
        if ((node.type === 'iframe' || node.type === 'youtube') && !isAllowedEmbedHost(src)) return null;
        const cleanAttrs = sanitizeAttrs(node.type, { ...node.attrs, src }, cfg);
        return { type: node.type, attrs: cleanAttrs };
    }

    const out: any = { type: node.type };
    const attrs = sanitizeAttrs(node.type, node.attrs, cfg);
    if (attrs) out.attrs = attrs;

    // Text nodes carry literal content + marks. We never modify the text
    // string itself — Tiptap renders text nodes as DOM textContent, which
    // is HTML-escaped automatically. No content-level XSS via text nodes.
    if (node.type === 'text') {
        if (typeof node.text !== 'string') return null;
        out.text = node.text;
        if (Array.isArray(node.marks)) {
            const marks = node.marks.map((m: any) => sanitizeMark(m, cfg)).filter(Boolean);
            if (marks.length > 0) out.marks = marks;
        }
        return out;
    }

    if (Array.isArray(node.content)) {
        const cleanChildren = node.content.map((child: any) => sanitizeNode(child, cfg, depth + 1)).filter(Boolean);
        if (cleanChildren.length > 0) out.content = cleanChildren;
    }
    return out;
}

export function sanitizeTiptapJson(raw: unknown, mode: TiptapValidatorMode): any {
    const cfg = ALLOW[mode];
    if (!raw || typeof raw !== 'object') {
        // Allow callers to pass an empty object/null — return empty doc.
        return { type: 'doc', content: [] };
    }
    const root = raw as any;
    if (root.type !== 'doc') {
        throw new Error(`Tiptap document must have type 'doc' (got '${root.type}')`);
    }
    const cleaned = sanitizeNode(root, cfg);
    return cleaned || { type: 'doc', content: [] };
}

// ---------------------------------------------------------------------------
// JSON → safe HTML
// ---------------------------------------------------------------------------

const HTML_ESCAPE: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

function escapeAttr(s: string): string {
    // Same set as escapeHtml — sufficient for double-quoted attrs which the
    // emitter uses exclusively below.
    return escapeHtml(s);
}

// Marks → opening + closing tag pair. Order matters for nesting: outer
// marks are emitted first, inner marks last.
const MARK_TAGS: Record<string, [string, string] | ((attrs: any) => [string, string])> = {
    bold: ['<strong>', '</strong>'],
    italic: ['<em>', '</em>'],
    underline: ['<u>', '</u>'],
    strike: ['<s>', '</s>'],
    code: ['<code>', '</code>'],
    link: (attrs: any) => {
        const href = escapeAttr(attrs?.href || '#');
        return [`<a href="${href}" target="_blank" rel="noopener noreferrer">`, '</a>'];
    },
};

function emitMarks(marks: any[]): { open: string; close: string } {
    let open = '';
    let close = '';
    for (const mark of marks) {
        const tag = MARK_TAGS[mark.type];
        if (!tag) continue;
        const [o, c] = typeof tag === 'function' ? tag(mark.attrs) : tag;
        open += o;
        close = c + close; // close in reverse order
    }
    return { open, close };
}

function emitNode(node: any, depth = 0): string {
    if (!node) return '';
    // Depth cap: at the ceiling, truncate the subtree (emit nothing for it)
    // rather than recursing further. Emit input is normally pre-sanitized,
    // but tiptapJsonToSafeHtml re-sanitizes defensively, so this is a second
    // independent guard against stack exhaustion.
    if (depth > MAX_DEPTH) return '';
    if (node.type === 'text') {
        const text = escapeHtml(typeof node.text === 'string' ? node.text : '');
        if (Array.isArray(node.marks) && node.marks.length > 0) {
            const { open, close } = emitMarks(node.marks);
            return `${open}${text}${close}`;
        }
        return text;
    }

    const inner = Array.isArray(node.content) ? node.content.map((child: any) => emitNode(child, depth + 1)).join('') : '';

    switch (node.type) {
        case 'doc': return inner;
        case 'paragraph': return `<p>${inner}</p>`;
        case 'heading': {
            const level = Math.min(Math.max(parseInt(node.attrs?.level) || 2, 1), 6);
            return `<h${level}>${inner}</h${level}>`;
        }
        case 'bulletList': return `<ul>${inner}</ul>`;
        case 'orderedList': return `<ol>${inner}</ol>`;
        case 'listItem': return `<li>${inner}</li>`;
        case 'blockquote': return `<blockquote>${inner}</blockquote>`;
        case 'codeBlock': return `<pre><code>${inner}</code></pre>`;
        case 'horizontalRule': return '<hr>';
        case 'hardBreak': return '<br>';
        case 'image': {
            const src = escapeAttr(node.attrs?.src || '');
            const alt = escapeAttr(node.attrs?.alt || '');
            return `<img src="${src}" alt="${alt}">`;
        }
        case 'table': return `<table>${inner}</table>`;
        case 'tableRow': return `<tr>${inner}</tr>`;
        case 'tableCell': return `<td>${inner}</td>`;
        case 'tableHeader': return `<th>${inner}</th>`;
        default:
            // Unknown node — emit children only (fail open: keep content,
            // strip wrapper). Sanitizer should have already dropped these.
            return inner;
    }
}

export function tiptapJsonToSafeHtml(doc: any, mode: TiptapValidatorMode): string {
    // Re-sanitize defensively in case the caller passed unsanitized input.
    const cleaned = sanitizeTiptapJson(doc, mode);
    return emitNode(cleaned);
}

// ---------------------------------------------------------------------------
// Convenience: detect whether a string is Tiptap JSON or legacy plain text
// ---------------------------------------------------------------------------
// Used by render paths that need to handle both shapes during the migration
// window (e.g. public blurb: existing rows are plain text, new saves are JSON).

export function tryParseTiptapJson(value: unknown): any | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && parsed.type === 'doc') return parsed;
    } catch {
        // not JSON
    }
    return null;
}

// ---------------------------------------------------------------------------
// Empty-doc detection
// ---------------------------------------------------------------------------
// A freshly cleared editor saves `{type:'doc',content:[{type:'paragraph'}]}`
// — structurally a valid doc but visually nothing. Render paths that
// conditionally show a wrapper card (e.g. the public blurb) need to treat
// these as absent so they don't emit an empty `<p></p>` inside an "About"
// shell. Returns true if the doc has no text with non-whitespace content
// AND no visually-significant atomic nodes.

const VISIBLE_ATOMIC_NODES = new Set(['image', 'youtube', 'iframe', 'horizontalRule']);

function nodeHasContent(node: any, depth = 0): boolean {
    if (!node || typeof node !== 'object') return false;
    // Depth cap: at the ceiling, stop descending (treat the subtree as
    // empty) rather than recursing further. Anything that deep is dropped
    // by the sanitizer anyway, so reporting "no content" is consistent.
    if (depth > MAX_DEPTH) return false;
    if (node.type === 'text') {
        return typeof node.text === 'string' && node.text.trim().length > 0;
    }
    if (VISIBLE_ATOMIC_NODES.has(node.type)) return true;
    if (Array.isArray(node.content)) {
        return node.content.some((child: any) => nodeHasContent(child, depth + 1));
    }
    return false;
}

export function isEmptyTiptapDoc(doc: unknown): boolean {
    if (!doc || typeof doc !== 'object') return true;
    return !nodeHasContent(doc);
}
