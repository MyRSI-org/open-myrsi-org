import { describe, it, expect } from 'vitest';
import {
    relativeLuminance,
    contrastRatio,
    passes,
    nearestPassingShade,
    AA_BODY,
    AA_LARGE,
    AA_UI,
    AAA_BODY,
} from '../lib/a11y';

// lib/a11y.ts — the WCAG contrast maths behind the theme editor's live warnings
// (components/views/admin/ThemeEditorTab.tsx). UX-only, not a security boundary, so the
// contract is "invalid input fails safe, never throws". Expected values are computed
// independently from the WCAG 2.x formula (sRGB linearisation with the 0.03928 knee),
// not read back from the module.

describe('relativeLuminance', () => {
    it('maps the primaries to their WCAG channel weights', () => {
        expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 12);
        expect(relativeLuminance('#000000')).toBe(0);
        expect(relativeLuminance('#ff0000')).toBeCloseTo(0.2126, 12);
        expect(relativeLuminance('#00ff00')).toBeCloseTo(0.7152, 12);
        expect(relativeLuminance('#0000ff')).toBeCloseTo(0.0722, 12);
    });

    it('uses the linear segment at or below the 0.03928 knee', () => {
        // 10/255 = 0.0392156… <= 0.03928, so the value is v / 12.92, not the power curve.
        expect(relativeLuminance('#0a0a0a')).toBeCloseTo((10 / 255) / 12.92, 12);
    });

    it('uses the power curve above the knee', () => {
        expect(relativeLuminance('#808080')).toBeCloseTo(Math.pow((128 / 255 + 0.055) / 1.055, 2.4), 12);
        expect(relativeLuminance('#808080')).toBeCloseTo(0.21586050011389923, 12);
    });

    it('accepts shorthand and mixed case through the strict hex normaliser', () => {
        expect(relativeLuminance('#FFF')).toBeCloseTo(1, 12);
        expect(relativeLuminance('  #FfFfFf ')).toBeCloseTo(1, 12);
    });

    it('fails safe to 0 for anything that is not a strict hex colour', () => {
        for (const bad of ['red', 'rgb(255,255,255)', '#fffffff', '#ff', '', 'red;}body{display:none}', 'url(x)']) {
            expect(relativeLuminance(bad)).toBe(0);
        }
        expect(relativeLuminance(undefined as unknown as string)).toBe(0);
    });
});

describe('contrastRatio', () => {
    it('is 21 for black on white and 1 for identical colours', () => {
        expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
        expect(contrastRatio('#123456', '#123456')).toBe(1);
    });

    it('is symmetric (lighter colour always on top of the ratio)', () => {
        expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(4.542224959605253, 10);
        expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.542224959605253, 10);
        expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.478089453577214, 10);
    });

    it('treats an invalid colour as black rather than throwing', () => {
        expect(contrastRatio('not-a-colour', '#ffffff')).toBeCloseTo(21, 10);
    });
});

describe('passes + the WCAG constants', () => {
    it('exposes the WCAG 2.x thresholds', () => {
        expect(AA_BODY).toBe(4.5);
        expect(AA_LARGE).toBe(3.0);
        expect(AA_UI).toBe(3.0);
        expect(AAA_BODY).toBe(7.0);
    });

    it('defaults to AA body text (4.5:1) and is inclusive at the boundary', () => {
        expect(passes('#767676', '#ffffff')).toBe(true);   // 4.54
        expect(passes('#777777', '#ffffff')).toBe(false);  // 4.48
        expect(passes('#000000', '#ffffff', 21)).toBe(true); // exactly the maximum
    });

    it('honours an explicit minimum', () => {
        expect(passes('#777777', '#ffffff', AA_LARGE)).toBe(true);
        expect(passes('#767676', '#ffffff', AAA_BODY)).toBe(false);
        expect(passes('#949494', '#ffffff', AA_UI)).toBe(true);   // 3.03
        expect(passes('#959595', '#ffffff', AA_UI)).toBe(false);  // 2.995
    });
});

describe('nearestPassingShade', () => {
    it('returns the canonical form of a colour that already passes', () => {
        expect(nearestPassingShade('#000', '#ffffff')).toBe('#000000');
        expect(nearestPassingShade('#FFFFFF', '#000000')).toBe('#ffffff');
    });

    it('darkens on a light background by the minimal amount (the classic #767676)', () => {
        const out = nearestPassingShade('#777777', '#ffffff');
        expect(out).toBe('#767676');
        expect(passes(out, '#ffffff')).toBe(true);
    });

    it('lightens on a dark background, minimally, and the result clears the bar', () => {
        const out = nearestPassingShade('#333333', '#000000');
        const lighter = parseInt(out.slice(1, 3), 16);
        expect(lighter).toBeGreaterThan(0x33);
        expect(out).toMatch(/^#([0-9a-f]{2})\1\1$/); // a grey stays a grey
        expect(passes(out, '#000000')).toBe(true);
        // Minimal: one step darker no longer passes.
        const oneDarker = '#' + (lighter - 1).toString(16).padStart(2, '0').repeat(3);
        expect(passes(oneDarker, '#000000')).toBe(false);
    });

    it('honours a stricter minimum', () => {
        const out = nearestPassingShade('#777777', '#ffffff', AAA_BODY);
        expect(passes(out, '#ffffff', AAA_BODY)).toBe(true);
        expect(contrastRatio(out, '#ffffff')).toBeLessThan(7.1);
    });

    it('falls back to the pure endpoint when even that cannot reach the target', () => {
        // White on #777777 is 4.48:1, so no lightening can ever reach 4.5.
        expect(nearestPassingShade('#888888', '#777777')).toBe('#ffffff');
        // An impossible ratio on a light background bottoms out at pure black.
        expect(nearestPassingShade('#777777', '#ffffff', 22)).toBe('#000000');
    });

    it('fails safe to black for an invalid foreground', () => {
        expect(nearestPassingShade('red;}body{display:none}', '#ffffff')).toBe('#000000');
        expect(nearestPassingShade('', '#000000')).toBe('#000000');
    });

    it('only ever emits a strict #rrggbb value', () => {
        for (const [fg, bg] of [['#777777', '#ffffff'], ['#333333', '#000000'], ['#abc', '#bcd'], ['#123', 'junk']]) {
            expect(nearestPassingShade(fg, bg)).toMatch(/^#[0-9a-f]{6}$/);
        }
    });
});
