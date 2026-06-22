import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeJsonForScript } from '../api/index';

// The SSR handler (api/index.ts) puts org-controlled branding/OG/public-page values
// into the served index.html — into HTML attributes/text (escapeHtml) and into an
// inline <script> as JSON (escapeJsonForScript). Pin both so a refactor can't bring
// back reflected XSS / </script> breakout on the public landing page.

// Construct the JS line/paragraph separators from char codes (keeps this source
// pure-ASCII — embedding the literal U+2028/U+2029 bytes is error-prone).
const SEP_2028 = String.fromCharCode(0x2028);
const SEP_2029 = String.fromCharCode(0x2029);

describe('escapeHtml — SSR attribute/text context', () => {
    it('neutralizes the five HTML metacharacters', () => {
        expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
        expect(escapeHtml('" onmouseover="x')).toBe('&quot; onmouseover=&quot;x');
        expect(escapeHtml("a'b")).toBe('a&#39;b');
        expect(escapeHtml('a&b')).toBe('a&amp;b');
    });
    it('leaves no raw <, >, ", or \' after escaping a hostile string', () => {
        const out = escapeHtml('</title><script>alert(document.cookie)</script>');
        expect(out).not.toMatch(/[<>"']/);
    });
});

describe('escapeJsonForScript — inline <script> JSON context', () => {
    it('prevents </script> breakout (escapes < > &)', () => {
        const out = escapeJsonForScript({ name: '</script><script>alert(1)</script>' });
        expect(out).not.toContain('</script>');
        expect(out).not.toContain('<');
        expect(out).not.toContain('>');
        expect(out).toContain('\\u003c');
    });
    it('escapes & and the JS line/paragraph separators U+2028/U+2029', () => {
        const out = escapeJsonForScript({ a: 'x&y', sep: SEP_2028 + SEP_2029 });
        expect(out).not.toContain('&');
        expect(out).toContain('\\u0026');
        expect(out).toContain('\\u2028');
        expect(out).toContain('\\u2029');
        expect(out).not.toContain(SEP_2028); // no raw separator survives
        expect(out).not.toContain(SEP_2029);
    });
    it('output remains valid JSON that round-trips to the original payload', () => {
        const payload = { name: '</script>', motto: 'a & b', sep: SEP_2028 };
        expect(JSON.parse(escapeJsonForScript(payload))).toEqual(payload);
    });
});
