import { describe, it, expect } from 'vitest';
import {
    safeUrl, sanitizeTiptapJson, tiptapJsonToSafeHtml, tryParseTiptapJson,
    isEmptyTiptapDoc, collectImageSrcs, mapImageSrcs,
} from '../lib/tiptapValidate';

// lib/tiptapValidate.ts — the write-boundary sanitiser for rich text and the
// XSS-safe-by-construction HTML emitter. Complements tests/tiptapValidate.test.ts and
// tests/tiptapDepthLimit.test.ts with the remaining node/mark/attr branches.

const doc = (...content: unknown[]) => ({ type: 'doc', content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]) => (marks ? { type: 'text', text, marks } : { type: 'text', text });

/** Build `levels` nested blockquotes around a text leaf. */
function nestBlockquotes(levels: number, leaf: unknown): unknown {
    let node: unknown = leaf;
    for (let i = 0; i < levels; i++) node = { type: 'blockquote', content: [node] };
    return node;
}

describe('safeUrl edge cases', () => {
    it('trims surrounding whitespace and returns the normalised href', () => {
        expect(safeUrl('  https://Example.COM/a b  ')).toBe('https://example.com/a%20b');
        expect(safeUrl('  /wiki/page  ')).toBe('/wiki/page');
    });

    it('rejects whitespace-only, scheme-obfuscated and unparseable input', () => {
        expect(safeUrl('   ')).toBeNull();
        expect(safeUrl('JaVaScRiPt:alert(1)')).toBeNull();
        expect(safeUrl('\tjavascript:alert(1)')).toBeNull();
        expect(safeUrl('ftp://files.example/x')).toBeNull();
        expect(safeUrl('not a url')).toBeNull();
        expect(safeUrl('//evil.example/x')).toBeNull();
    });
});

describe('sanitizeTiptapJson — marks', () => {
    it('drops malformed marks (non-object, missing type, non-string type) but keeps the text', () => {
        const out = sanitizeTiptapJson(doc(p(t('hi', [null, 'bold', { attrs: {} }, { type: 7 }, { type: 'bold' }]))), 'wiki');
        expect(out.content[0].content[0]).toEqual({ type: 'text', text: 'hi', marks: [{ type: 'bold' }] });
    });

    it('omits the marks key entirely when every mark is dropped', () => {
        const out = sanitizeTiptapJson(doc(p(t('hi', [{ type: 'evil' }, { type: 'link', attrs: { href: 'data:text/html,x' } }]))), 'wiki');
        expect(out.content[0].content[0]).toEqual({ type: 'text', text: 'hi' });
    });

    it('drops a link mark with no attrs at all', () => {
        const out = sanitizeTiptapJson(doc(p(t('x', [{ type: 'link' }]))), 'wiki');
        expect(out.content[0].content[0].marks).toBeUndefined();
    });

    it('FORCES target=_blank and rel=noopener noreferrer, overriding attacker-supplied values', () => {
        const out = sanitizeTiptapJson(doc(p(t('x', [{
            type: 'link', attrs: { href: 'https://ok.example', target: '_self', rel: 'opener', onclick: 'alert(1)' },
        }]))), 'wiki');
        expect(out.content[0].content[0].marks).toEqual([
            { type: 'link', attrs: { href: 'https://ok.example/', target: '_blank', rel: 'noopener noreferrer' } },
        ]);
    });

    it('accepts mailto: on links (and only links)', () => {
        const out = sanitizeTiptapJson(doc(p(t('mail', [{ type: 'link', attrs: { href: 'mailto:a@b.example' } }]))), 'minimal');
        expect(out.content[0].content[0].marks[0].attrs.href).toBe('mailto:a@b.example');
        const img = sanitizeTiptapJson(doc({ type: 'image', attrs: { src: 'mailto:a@b.example' } }), 'wiki');
        expect(img.content).toBeUndefined();
    });

    it('keeps only allow-listed mark attrs (textAlign.align) and drops the rest', () => {
        const out = sanitizeTiptapJson(doc(p(t('x', [{ type: 'textAlign', attrs: { align: 'center', style: 'background:url(x)' } }]))), 'wiki');
        expect(out.content[0].content[0].marks).toEqual([{ type: 'textAlign', attrs: { align: 'center' } }]);
    });

    it('drops attrs on a mark that has no attr allow-list (bold with style)', () => {
        const out = sanitizeTiptapJson(doc(p(t('x', [{ type: 'bold', attrs: { style: 'x' } }]))), 'wiki');
        expect(out.content[0].content[0].marks).toEqual([{ type: 'bold' }]);
    });
});

describe('sanitizeTiptapJson — nodes and attrs', () => {
    it('drops a text node whose text is not a string', () => {
        const out = sanitizeTiptapJson(doc(p({ type: 'text', text: { toString: '<script>' } }, t('ok'))), 'wiki');
        expect(out.content[0].content).toEqual([{ type: 'text', text: 'ok' }]);
    });

    it('drops malformed children (null, primitives, missing or non-string type)', () => {
        const out = sanitizeTiptapJson(doc(null, 'para', 3, { content: [] }, { type: ['paragraph'] }, p(t('kept'))), 'wiki');
        expect(out.content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'kept' }] }]);
    });

    it('omits content when every child is dropped, and attrs when nothing allow-listed survives', () => {
        const out = sanitizeTiptapJson(doc({ type: 'paragraph', attrs: { onclick: 'x', textAlign: null }, content: [{ type: 'script' }] }), 'wiki');
        expect(out.content).toEqual([{ type: 'paragraph' }]);
    });

    it('ignores a non-object attrs value', () => {
        const out = sanitizeTiptapJson(doc({ type: 'heading', attrs: 'level=1', content: [t('h')] }), 'wiki');
        expect(out.content[0]).toEqual({ type: 'heading', content: [{ type: 'text', text: 'h' }] });
    });

    it('keeps the allow-listed attrs per node type and nothing else', () => {
        const out = sanitizeTiptapJson(doc(
            { type: 'heading', attrs: { level: 3, textAlign: 'right', id: 'x', style: 'y' }, content: [t('h')] },
            { type: 'codeBlock', attrs: { language: 'ts', class: 'evil' }, content: [t('code')] },
            { type: 'table', content: [{ type: 'tableRow', content: [
                { type: 'tableHeader', attrs: { colspan: 2, rowspan: 1, colwidth: [100], onmouseover: 'x' }, content: [p(t('th'))] },
                { type: 'tableCell', attrs: { colspan: 1, background: 'red' }, content: [p(t('td'))] },
            ] }] },
        ), 'wiki');
        expect(out.content[0].attrs).toEqual({ level: 3, textAlign: 'right' });
        expect(out.content[1].attrs).toEqual({ language: 'ts' });
        const row = out.content[2].content[0].content;
        expect(row[0].attrs).toEqual({ colspan: 2, rowspan: 1, colwidth: [100] });
        expect(row[1].attrs).toEqual({ colspan: 1 });
    });

    it('minimal mode drops heading textAlign (not on its allow-list) but keeps level', () => {
        const out = sanitizeTiptapJson(doc({ type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [t('h')] }), 'minimal');
        expect(out.content[0].attrs).toEqual({ level: 2 });
    });

    it('image keeps only src/alt/title and drops event-handler attrs', () => {
        const out = sanitizeTiptapJson(doc({ type: 'image', attrs: { src: 'https://img.example/a.png', alt: 'a', title: 't', onerror: 'alert(1)', width: 9 } }), 'wiki');
        expect(out.content[0]).toEqual({ type: 'image', attrs: { src: 'https://img.example/a.png', alt: 'a', title: 't' } });
    });

    it('drops an image with no attrs, and an iframe/youtube with a javascript: src', () => {
        const out = sanitizeTiptapJson(doc(
            { type: 'image' },
            { type: 'iframe', attrs: { src: 'javascript:alert(1)' } },
            { type: 'youtube', attrs: { src: 'data:text/html,<script>' } },
        ), 'wiki');
        expect(out.content).toBeUndefined();
    });

    it('keeps an allow-listed iframe with its size attrs only', () => {
        const out = sanitizeTiptapJson(doc({ type: 'iframe', attrs: { src: 'https://player.vimeo.com/video/1', width: 640, height: 360, allow: 'camera' } }), 'wiki');
        expect(out.content[0]).toEqual({ type: 'iframe', attrs: { src: 'https://player.vimeo.com/video/1', width: 640, height: 360 } });
    });

    it('returns an empty doc for a non-object root (string / number)', () => {
        expect(sanitizeTiptapJson('{"type":"doc"}', 'wiki')).toEqual({ type: 'doc', content: [] });
        expect(sanitizeTiptapJson(42, 'minimal')).toEqual({ type: 'doc', content: [] });
    });

    it('names the offending root type in the error', () => {
        expect(() => sanitizeTiptapJson({ type: 'paragraph' }, 'wiki')).toThrow("Tiptap document must have type 'doc' (got 'paragraph')");
    });

    it('drops a subtree nested past the depth cap but keeps shallower siblings', () => {
        const deep = nestBlockquotes(150, t('too deep'));
        const out = sanitizeTiptapJson(doc(p(t('shallow')), deep), 'wiki');
        expect(out.content[0]).toEqual({ type: 'paragraph', content: [{ type: 'text', text: 'shallow' }] });
        expect(JSON.stringify(out)).not.toContain('too deep');
    });
});

describe('tiptapJsonToSafeHtml — wiki node emission', () => {
    it('emits every block type with its fixed tag', () => {
        const html = tiptapJsonToSafeHtml(doc(
            { type: 'blockquote', content: [p(t('q'))] },
            { type: 'codeBlock', content: [t('a < b')] },
            { type: 'horizontalRule' },
            p(t('line1'), { type: 'hardBreak' }, t('line2')),
            { type: 'orderedList', content: [{ type: 'listItem', content: [p(t('one'))] }] },
            { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('dot'))] }] },
            { type: 'table', content: [{ type: 'tableRow', content: [
                { type: 'tableHeader', content: [p(t('H'))] },
                { type: 'tableCell', content: [p(t('C'))] },
            ] }] },
        ), 'wiki');
        expect(html).toBe(
            '<blockquote><p>q</p></blockquote>'
            + '<pre><code>a &lt; b</code></pre>'
            + '<hr>'
            + '<p>line1<br>line2</p>'
            + '<ol><li><p>one</p></li></ol>'
            + '<ul><li><p>dot</p></li></ul>'
            + '<table><tr><th><p>H</p></th><td><p>C</p></td></tr></table>',
        );
    });

    it('clamps heading levels into 1..6 and defaults junk to h2', () => {
        const h = (level: unknown) => tiptapJsonToSafeHtml(doc({ type: 'heading', attrs: { level }, content: [t('x')] }), 'wiki');
        expect(h(1)).toBe('<h1>x</h1>');
        expect(h(9)).toBe('<h6>x</h6>');
        expect(h(-4)).toBe('<h1>x</h1>');
        expect(h('3')).toBe('<h3>x</h3>');
        expect(h('onclick=1')).toBe('<h2>x</h2>');
        expect(tiptapJsonToSafeHtml(doc({ type: 'heading', content: [t('x')] }), 'wiki')).toBe('<h2>x</h2>');
    });

    it('emits an image with escaped src and alt — an attribute breakout stays inside the quotes', () => {
        const html = tiptapJsonToSafeHtml(doc({ type: 'image', attrs: { src: 'https://img.example/a.png?x=1&y=2', alt: '" onerror="alert(1)' } }), 'wiki');
        expect(html).toBe('<img src="https://img.example/a.png?x=1&amp;y=2" alt="&quot; onerror=&quot;alert(1)">');
    });

    it('emits an image with no alt as an empty alt', () => {
        expect(tiptapJsonToSafeHtml(doc({ type: 'image', attrs: { src: 'https://img.example/a.png' } }), 'wiki'))
            .toBe('<img src="https://img.example/a.png" alt="">');
    });

    it('never emits an <iframe> — embeds render as nothing in the HTML path', () => {
        const html = tiptapJsonToSafeHtml(doc(
            { type: 'iframe', attrs: { src: 'https://player.vimeo.com/video/1' } },
            { type: 'youtube', attrs: { src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' } },
            p(t('after')),
        ), 'wiki');
        expect(html).toBe('<p>after</p>');
        expect(html).not.toMatch(/iframe|youtube/i);
    });

    it('nests marks outer-first and closes them in reverse order', () => {
        const html = tiptapJsonToSafeHtml(doc(p(t('x', [
            { type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'strike' }, { type: 'code' },
        ]))), 'wiki');
        expect(html).toBe('<p><strong><em><u><s><code>x</code></s></u></em></strong></p>');
    });

    it('wraps link text in an escaped, hardened anchor', () => {
        const html = tiptapJsonToSafeHtml(doc(p(t('go', [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://ok.example/?a="b"&c' } }]))), 'wiki');
        expect(html).toBe('<p><strong><a href="https://ok.example/?a=%22b%22&amp;c" target="_blank" rel="noopener noreferrer">go</a></strong></p>');
    });

    it('skips marks with no HTML form (textAlign) and emits the bare text', () => {
        const html = tiptapJsonToSafeHtml(doc(p(t('aligned', [{ type: 'textAlign', attrs: { align: 'center' } }]))), 'wiki');
        expect(html).toBe('<p>aligned</p>');
    });

    it('drops disallowed nodes in minimal mode before emitting', () => {
        const html = tiptapJsonToSafeHtml(doc({ type: 'table', content: [] }, { type: 'image', attrs: { src: 'https://img.example/x.png' } }, p(t('ok'))), 'minimal');
        expect(html).toBe('<p>ok</p>');
    });

    it('emits nothing for an empty/invalid input', () => {
        expect(tiptapJsonToSafeHtml(null, 'minimal')).toBe('');
        expect(tiptapJsonToSafeHtml(doc(), 'wiki')).toBe('');
    });
});

describe('tryParseTiptapJson', () => {
    it('returns null for non-strings, non-object JSON, invalid JSON and non-doc objects', () => {
        expect(tryParseTiptapJson({ type: 'doc' })).toBeNull();
        expect(tryParseTiptapJson(undefined)).toBeNull();
        expect(tryParseTiptapJson('plain legacy text')).toBeNull();
        expect(tryParseTiptapJson('[1,2]')).toBeNull();
        expect(tryParseTiptapJson('{not json')).toBeNull();
        expect(tryParseTiptapJson('{"type":"paragraph"}')).toBeNull();
    });

    it('parses a doc with leading whitespace', () => {
        expect(tryParseTiptapJson('   {"type":"doc","content":[]}  ')).toEqual({ type: 'doc', content: [] });
    });
});

describe('isEmptyTiptapDoc', () => {
    it('treats youtube and iframe embeds as visible content', () => {
        expect(isEmptyTiptapDoc(doc({ type: 'youtube', attrs: { src: 'x' } }))).toBe(false);
        expect(isEmptyTiptapDoc(doc({ type: 'iframe' }))).toBe(false);
    });

    it('treats a non-string text node and non-object children as empty', () => {
        expect(isEmptyTiptapDoc(doc(p({ type: 'text', text: 42 }), null, 'str'))).toBe(true);
    });

    it('treats a leaf node with no content array as empty', () => {
        expect(isEmptyTiptapDoc(doc({ type: 'hardBreak' }))).toBe(true);
    });

    it('treats text nested past the depth cap as empty (consistent with the sanitiser dropping it)', () => {
        expect(isEmptyTiptapDoc(doc(nestBlockquotes(150, t('hidden'))))).toBe(true);
        expect(isEmptyTiptapDoc(doc(nestBlockquotes(5, t('visible'))))).toBe(false);
    });
});

describe('collectImageSrcs', () => {
    it('collects each distinct non-empty string src across the tree', () => {
        const tree = doc(
            { type: 'image', attrs: { src: 'a.png' } },
            p({ type: 'image', attrs: { src: 'b.png' } }),
            { type: 'image', attrs: { src: 'a.png' } },
            { type: 'image', attrs: { src: '' } },
            { type: 'image', attrs: { src: 7 } },
            { type: 'image', attrs: null },
            { type: 'paragraph', attrs: { src: 'not-an-image.png' } },
        );
        expect([...collectImageSrcs(tree)].sort()).toEqual(['a.png', 'b.png']);
    });

    it('returns the given set unchanged for non-object input, and appends into a provided set', () => {
        const seed = new Set(['seed']);
        expect(collectImageSrcs(null, seed)).toBe(seed);
        expect([...collectImageSrcs('x', seed)]).toEqual(['seed']);
        collectImageSrcs({ type: 'image', attrs: { src: 'n.png' } }, seed);
        expect([...seed]).toEqual(['seed', 'n.png']);
    });
});

describe('mapImageSrcs', () => {
    it('rewrites every image src, preserving other attrs, without mutating the input', () => {
        const input = doc({ type: 'image', attrs: { src: 'a.png', alt: 'A' } }, p(t('x'), { type: 'image', attrs: { src: 'b.png' } }));
        const snapshot = JSON.stringify(input);
        const out = mapImageSrcs(input, (s) => `signed:${s}`);
        expect(out).toEqual(doc(
            { type: 'image', attrs: { src: 'signed:a.png', alt: 'A' } },
            p(t('x'), { type: 'image', attrs: { src: 'signed:b.png' } }),
        ));
        expect(JSON.stringify(input)).toBe(snapshot);
        expect(out).not.toBe(input);
    });

    it('DROPS an image the mapper refuses (fail closed) and one with no usable src, without calling fn for it', () => {
        const seen: string[] = [];
        const out = mapImageSrcs(doc(
            { type: 'image', attrs: { src: 'keep.png' } },
            { type: 'image', attrs: { src: 'deny.png' } },
            { type: 'image', attrs: { src: 99 } },
            { type: 'image' },
        ), (s) => { seen.push(s); return s === 'deny.png' ? null : s; });
        expect(out).toEqual(doc({ type: 'image', attrs: { src: 'keep.png' } }));
        expect(seen).toEqual(['keep.png', 'deny.png']);
    });

    it('returns a bare image root as null when refused, and leaves non-objects and leaves untouched', () => {
        expect(mapImageSrcs({ type: 'image', attrs: { src: 'x' } }, () => '')).toBeNull();
        expect(mapImageSrcs(null, () => 'y')).toBeNull();
        expect(mapImageSrcs('s', () => 'y')).toBe('s');
        const leaf = { type: 'text', text: 'hi' };
        expect(mapImageSrcs(leaf, () => 'y')).toBe(leaf);
    });
});
