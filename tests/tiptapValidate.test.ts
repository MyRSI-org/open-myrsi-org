import { describe, it, expect } from 'vitest';
import { sanitizeTiptapJson, tiptapJsonToSafeHtml, safeUrl, tryParseTiptapJson, isEmptyTiptapDoc } from '../lib/tiptapValidate';

// Locks the sanitizer + safe-HTML emitter contract. A regression here reopens
// an XSS surface on the public landing-page blurb (anonymous render path), so
// the attack-vector assertions are exhaustive.

describe('safeUrl', () => {
    it('accepts http(s) absolute URLs', () => {
        expect(safeUrl('https://example.com/foo')).toMatch(/^https:\/\/example.com\/foo/);
        expect(safeUrl('http://example.com')).toMatch(/^http:\/\//);
    });
    it('accepts root-relative paths', () => {
        expect(safeUrl('/wiki/page')).toBe('/wiki/page');
    });
    it('accepts mailto: only when allowed', () => {
        expect(safeUrl('mailto:x@y.com')).toBeNull();
        expect(safeUrl('mailto:x@y.com', { allowMailto: true })).toBe('mailto:x@y.com');
    });
    it('rejects javascript:, data:, vbscript:, file:', () => {
        expect(safeUrl('javascript:alert(1)')).toBeNull();
        expect(safeUrl('JavaScript:alert(1)')).toBeNull();
        expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
        expect(safeUrl('vbscript:msgbox')).toBeNull();
        expect(safeUrl('file:///etc/passwd')).toBeNull();
    });
    it('rejects protocol-relative URLs', () => {
        expect(safeUrl('//evil.com')).toBeNull();
    });
    it('rejects empty / non-string', () => {
        expect(safeUrl('')).toBeNull();
        expect(safeUrl('   ')).toBeNull();
        expect(safeUrl(null)).toBeNull();
        expect(safeUrl(undefined)).toBeNull();
        expect(safeUrl(42)).toBeNull();
    });
});

describe('sanitizeTiptapJson — wiki mode', () => {
    it('keeps allowed nodes and marks', () => {
        const input = {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'hello ' },
                        { type: 'text', text: 'world', marks: [{ type: 'bold' }] },
                    ],
                },
            ],
        };
        const out = sanitizeTiptapJson(input, 'wiki');
        expect(out.type).toBe('doc');
        expect(out.content[0].type).toBe('paragraph');
        expect(out.content[0].content[1].marks[0].type).toBe('bold');
    });

    it('drops disallowed node types', () => {
        const input = {
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
                { type: 'evilNode', content: [{ type: 'text', text: 'gone' }] },
            ],
        };
        const out = sanitizeTiptapJson(input, 'wiki');
        expect(out.content).toHaveLength(1);
        expect(out.content[0].content[0].text).toBe('kept');
    });

    it('drops link marks with javascript: href', () => {
        const input = {
            type: 'doc',
            content: [{
                type: 'paragraph',
                content: [{
                    type: 'text',
                    text: 'click',
                    marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                }],
            }],
        };
        const out = sanitizeTiptapJson(input, 'wiki');
        // Mark gone, text preserved
        expect(out.content[0].content[0].text).toBe('click');
        expect(out.content[0].content[0].marks).toBeUndefined();
    });

    it('drops image nodes with data: src', () => {
        const input = {
            type: 'doc',
            content: [
                { type: 'image', attrs: { src: 'data:image/svg+xml,<svg onload=alert(1)>' } },
                { type: 'image', attrs: { src: 'https://example.com/ok.png' } },
            ],
        };
        const out = sanitizeTiptapJson(input, 'wiki');
        expect(out.content).toHaveLength(1);
        expect(out.content[0].attrs.src).toMatch(/^https:/);
    });

    it('drops iframe/youtube nodes whose host is not allow-listed; keeps allow-listed embeds', () => {
        const input = {
            type: 'doc',
            content: [
                { type: 'iframe', attrs: { src: 'https://evil.example.com/embed' } },        // off-list → dropped
                { type: 'youtube', attrs: { src: 'https://evil.example.com/embed' } },       // off-list → dropped
                { type: 'iframe', attrs: { src: 'https://www.youtube.com/embed/abc' } },      // allow-listed → kept
                { type: 'iframe', attrs: { src: 'https://player.vimeo.com/video/123' } },     // allow-listed → kept
            ],
        };
        const out = sanitizeTiptapJson(input, 'wiki');
        expect(out.content).toHaveLength(2);
        const srcs = out.content.map((n: any) => n.attrs.src);
        expect(srcs.some((s: string) => s.includes('youtube.com'))).toBe(true);
        expect(srcs.some((s: string) => s.includes('vimeo.com'))).toBe(true);
        expect(srcs.some((s: string) => s.includes('evil'))).toBe(false);
    });

    it('drops a non-https iframe even on an allow-listed host (write-boundary parity with CSP)', () => {
        const input = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep' }] }, { type: 'iframe', attrs: { src: 'http://www.youtube.com/embed/abc' } }] };
        const out = sanitizeTiptapJson(input, 'wiki');
        // The http iframe is dropped; the paragraph survives.
        expect(out.content).toHaveLength(1);
        expect(out.content[0].type).toBe('paragraph');
    });

    it('preserves the literal text of script-looking strings — Tiptap renders text as DOM textContent, not HTML', () => {
        const input = {
            type: 'doc',
            content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: '<script>alert(1)</script>' }],
            }],
        };
        const out = sanitizeTiptapJson(input, 'wiki');
        // Stored verbatim — the safety guarantee is at the renderer (textContent),
        // not at the storage layer. The HTML emitter test below confirms it's
        // escaped on render.
        expect(out.content[0].content[0].text).toBe('<script>alert(1)</script>');
    });

    it('strips disallowed attrs', () => {
        const input = {
            type: 'doc',
            content: [{
                type: 'image',
                attrs: { src: 'https://example.com/x.png', onerror: 'alert(1)' },
            }],
        };
        const out = sanitizeTiptapJson(input, 'wiki');
        expect(out.content[0].attrs).toEqual({ src: 'https://example.com/x.png' });
        expect(out.content[0].attrs.onerror).toBeUndefined();
    });

    it('throws on non-doc root', () => {
        expect(() => sanitizeTiptapJson({ type: 'paragraph' }, 'wiki')).toThrow(/must have type 'doc'/);
    });

    it('returns empty doc for null/undefined input', () => {
        expect(sanitizeTiptapJson(null, 'wiki')).toEqual({ type: 'doc', content: [] });
        expect(sanitizeTiptapJson(undefined, 'wiki')).toEqual({ type: 'doc', content: [] });
    });
});

describe('sanitizeTiptapJson — minimal mode (public blurb)', () => {
    it('drops table/image/iframe/youtube even though they are valid Tiptap nodes', () => {
        const input = {
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
                { type: 'table', content: [] },
                { type: 'image', attrs: { src: 'https://example.com/x.png' } },
                { type: 'iframe', attrs: { src: 'https://youtube.com/embed/x' } },
                { type: 'youtube', attrs: { src: 'https://youtube.com/embed/x' } },
            ],
        };
        const out = sanitizeTiptapJson(input, 'minimal');
        expect(out.content).toHaveLength(1);
        expect(out.content[0].type).toBe('paragraph');
    });

    it('drops codeBlock + blockquote in minimal mode', () => {
        const input = {
            type: 'doc',
            content: [
                { type: 'codeBlock', content: [{ type: 'text', text: 'x' }] },
                { type: 'blockquote', content: [{ type: 'text', text: 'y' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
            ],
        };
        const out = sanitizeTiptapJson(input, 'minimal');
        expect(out.content).toHaveLength(1);
        expect(out.content[0].type).toBe('paragraph');
    });

    it('keeps bold/italic/link marks', () => {
        const input = {
            type: 'doc',
            content: [{
                type: 'paragraph',
                content: [{
                    type: 'text',
                    text: 'click',
                    marks: [
                        { type: 'bold' },
                        { type: 'link', attrs: { href: 'https://example.com' } },
                    ],
                }],
            }],
        };
        const out = sanitizeTiptapJson(input, 'minimal');
        expect(out.content[0].content[0].marks).toHaveLength(2);
    });

    it('drops underline/strike marks in minimal mode', () => {
        const input = {
            type: 'doc',
            content: [{
                type: 'paragraph',
                content: [{
                    type: 'text',
                    text: 'x',
                    marks: [{ type: 'underline' }, { type: 'strike' }, { type: 'bold' }],
                }],
            }],
        };
        const out = sanitizeTiptapJson(input, 'minimal');
        expect(out.content[0].content[0].marks).toEqual([{ type: 'bold' }]);
    });
});

describe('tiptapJsonToSafeHtml — minimal mode', () => {
    it('round-trips a basic doc', () => {
        const doc = {
            type: 'doc',
            content: [
                { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world', marks: [{ type: 'bold' }] }] },
            ],
        };
        const html = tiptapJsonToSafeHtml(doc, 'minimal');
        expect(html).toBe('<h2>Title</h2><p>Hello <strong>world</strong></p>');
    });

    it('HTML-escapes script-looking text', () => {
        const doc = {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] }],
        };
        const html = tiptapJsonToSafeHtml(doc, 'minimal');
        expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
        expect(html).not.toContain('<script>');
    });

    it('escapes all dangerous chars including quotes and ampersands', () => {
        const doc = {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `&"'<>` }] }],
        };
        const html = tiptapJsonToSafeHtml(doc, 'minimal');
        expect(html).toBe('<p>&amp;&quot;&#39;&lt;&gt;</p>');
    });

    it('emits links with safe href and noopener rel', () => {
        const doc = {
            type: 'doc',
            content: [{
                type: 'paragraph',
                content: [{
                    type: 'text',
                    text: 'click',
                    marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
                }],
            }],
        };
        const html = tiptapJsonToSafeHtml(doc, 'minimal');
        expect(html).toContain('href="https://example.com/"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).toContain('target="_blank"');
    });

    it('drops javascript: links entirely (text remains)', () => {
        const doc = {
            type: 'doc',
            content: [{
                type: 'paragraph',
                content: [{
                    type: 'text',
                    text: 'evil',
                    marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                }],
            }],
        };
        const html = tiptapJsonToSafeHtml(doc, 'minimal');
        expect(html).toBe('<p>evil</p>');
        expect(html).not.toContain('href');
    });

    it('emits lists correctly', () => {
        const doc = {
            type: 'doc',
            content: [{
                type: 'bulletList',
                content: [
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] },
                    { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] },
                ],
            }],
        };
        const html = tiptapJsonToSafeHtml(doc, 'minimal');
        expect(html).toBe('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
    });
});

describe('isEmptyTiptapDoc', () => {
    it('treats a freshly cleared editor (single empty paragraph) as empty', () => {
        expect(isEmptyTiptapDoc({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
    });
    it('treats an empty content array as empty', () => {
        expect(isEmptyTiptapDoc({ type: 'doc', content: [] })).toBe(true);
    });
    it('treats a paragraph with empty content array as empty', () => {
        expect(isEmptyTiptapDoc({ type: 'doc', content: [{ type: 'paragraph', content: [] }] })).toBe(true);
    });
    it('treats whitespace-only text as empty', () => {
        expect(isEmptyTiptapDoc({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }],
        })).toBe(true);
    });
    it('treats a doc with real text as non-empty', () => {
        expect(isEmptyTiptapDoc({
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
        })).toBe(false);
    });
    it('treats a doc with only an image as non-empty', () => {
        expect(isEmptyTiptapDoc({
            type: 'doc',
            content: [{ type: 'image', attrs: { src: 'https://example.com/x.png' } }],
        })).toBe(false);
    });
    it('treats a doc with only a horizontal rule as non-empty', () => {
        expect(isEmptyTiptapDoc({
            type: 'doc',
            content: [{ type: 'horizontalRule' }],
        })).toBe(false);
    });
    it('treats null/undefined/non-object as empty', () => {
        expect(isEmptyTiptapDoc(null)).toBe(true);
        expect(isEmptyTiptapDoc(undefined)).toBe(true);
        expect(isEmptyTiptapDoc('')).toBe(true);
    });
});

describe('tryParseTiptapJson', () => {
    it('returns parsed doc for valid Tiptap JSON', () => {
        const json = JSON.stringify({ type: 'doc', content: [] });
        expect(tryParseTiptapJson(json)).toEqual({ type: 'doc', content: [] });
    });
    it('returns null for plain text (legacy blurb)', () => {
        expect(tryParseTiptapJson('Hello, world!')).toBeNull();
    });
    it('returns null for malformed JSON', () => {
        expect(tryParseTiptapJson('{ not json')).toBeNull();
    });
    it('returns null for JSON without type=doc', () => {
        expect(tryParseTiptapJson(JSON.stringify({ type: 'paragraph' }))).toBeNull();
    });
    it('returns null for non-string', () => {
        expect(tryParseTiptapJson(null)).toBeNull();
        expect(tryParseTiptapJson(123)).toBeNull();
    });
});
