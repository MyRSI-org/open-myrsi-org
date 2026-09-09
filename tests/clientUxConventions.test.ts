import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Source-text pins for the client conventions this unit restored. They are here because each
// one is a convention the tree ALREADY holds in every sibling file but one — which is exactly
// the kind of thing that drifts back silently, since nothing else in CI reads these files.

const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('operation cards are reachable by keyboard', () => {
    const src = read('components/views/operations/operations/OperationCard.tsx');

    it('both card variants are focusable and activatable', () => {
        // The whole card is the click target and neither variant contains a <button>, <a> or
        // <input>, so without this the Operations Center is mouse-only. That also means
        // role="button" creates no nested-widget conflict.
        expect((src.match(/role="button"/g) || []).length).toBeGreaterThanOrEqual(2);
        expect((src.match(/tabIndex=\{0\}/g) || []).length).toBeGreaterThanOrEqual(2);
        expect((src.match(/onKeyDown=\{/g) || []).length).toBeGreaterThanOrEqual(2);
    });

    it('activates on Enter AND Space, and stops Space scrolling the page underneath', () => {
        // Asserts the PREDICATE, not the handler's identifier — a later parity sweep renaming
        // it would otherwise redden CI for no behavioural reason.
        expect(src).toMatch(/e\.key === 'Enter'/);
        expect(src).toMatch(/e\.key === ' '/);
        expect(src).toMatch(/preventDefault\(\)/);
    });

    it('every interactive card carries an accessible name', () => {
        expect((src.match(/aria-label=\{`Open /g) || []).length).toBeGreaterThanOrEqual(2);
    });
});

describe('WindowFrame announces itself as a dialog', () => {
    const src = read('components/layout/WindowFrame.tsx');

    it('has role="dialog" and an accessible name from its title', () => {
        expect(src).toMatch(/role="dialog"/);
        expect(src).toMatch(/aria-label=\{title\}/);
    });

    it('does NOT set aria-modal', () => {
        // `isMobile` is useState(false) set only by an effect, so a conditional aria-modal
        // renders "false" on the dialog's first committed frame on a phone and flips one tick
        // later — unreliable in exactly the case it would be asserting. And on desktop the
        // frame renders no scrim, so claiming modality would be a lie. role="dialog" alone is
        // correct at both breakpoints.
        expect(src).not.toMatch(/aria-modal/);
    });

    it('the close button has a name — it is an icon-only control', () => {
        const at = src.indexOf('onClick={onClose}');
        expect(at).toBeGreaterThan(-1);
        expect(src.slice(at, at + 300)).toMatch(/aria-label="Close"/);
    });
});

describe('every HR "My*" tab switches to cards on a phone', () => {
    // Four of the five already did. MyOperationsTab was the one that made a phone scroll a
    // four-column table sideways, and matching the siblings is what makes this ratchetable.
    const dir = 'components/views/hr';
    const tabs = readdirSync(join(ROOT, dir)).filter((f) => /^My.*Tab\.tsx$/.test(f));

    it('finds the tabs it claims to check', () => {
        expect(tabs.length).toBeGreaterThanOrEqual(4);
    });

    it.each(tabs)('%s pairs a desktop-only table with a mobile list', (file) => {
        const src = read(join(dir, file));
        if (!/<table/.test(src)) return;   // a tab with no table has nothing to switch
        expect(src, `${file}: table is not desktop-only`).toMatch(/<table[^>]*hidden md:table/);
        expect(src, `${file}: no md:hidden mobile list`).toMatch(/md:hidden/);
    });
});

describe('the quartermaster armoury has one Add Stock control, and an honest empty state', () => {
    const tab = read('components/views/quartermaster/QmArmoryTab.tsx');
    const view = read('components/views/quartermaster/QuartermasterView.tsx');

    it('the duplicate toolbar button is gone — the hero button is the only one', () => {
        // Both were gated identically (canManage), so this narrows nothing; it just stops
        // rendering the same action twice on the same screen. Asserts the absence of a
        // BUTTON, not of the words: the empty-state copy still names the control, which is
        // the point of the canManage branch below.
        expect(tab).not.toMatch(/<button[\s\S]{0,400}Add Stock/);
        expect(view).toMatch(/Add Stock/);
    });

    it('the dead onCreate prop went with it', () => {
        // Nothing in this repo lints an unused VARIABLE — only unused imports — so an
        // orphaned prop would have sat here silently.
        expect(tab).not.toMatch(/\bonCreate\b/);
        expect(view).not.toMatch(/onCreate=\{canManage/);
    });

    it('the empty state does not tell a view-only member to use a button they cannot see', () => {
        const at = tab.indexOf('No items match the current filters');
        expect(at).toBeGreaterThan(-1);
        const block = tab.slice(Math.max(0, at - 400), at + 400);
        expect(block).toMatch(/canManage/);
    });
});
