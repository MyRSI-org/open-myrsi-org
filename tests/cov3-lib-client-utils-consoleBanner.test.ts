import { describe, it, expect, vi, afterEach } from 'vitest';
import { printConsoleBanner } from '../lib/consoleBanner';

// lib/consoleBanner.ts — the console calling-card printed at boot by index.tsx. Purely
// cosmetic, so the contract is: exactly three styled lines carrying the responsible-
// disclosure contact, and a vanity banner can NEVER break boot (missing/broken console).

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('printConsoleBanner', () => {
    it('prints exactly three %c-styled lines', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        printConsoleBanner();
        expect(log).toHaveBeenCalledTimes(3);
        for (const call of log.mock.calls) {
            expect(call).toHaveLength(2);
            expect(String(call[0]).startsWith('%c')).toBe(true);
            expect(String(call[1])).toMatch(/^font-size:\d+px;/);
        }
        expect(log.mock.calls[0]).toEqual(['%c👋 Poking around the internals?', 'font-size:16px;font-weight:700;color:#38bdf8']);
    });

    it('carries the license note and the responsible-disclosure contact', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        printConsoleBanner();
        expect(String(log.mock.calls[1][0])).toContain('noncommercial license');
        const disclosure = String(log.mock.calls[2][0]);
        expect(disclosure).toContain('report it responsibly to hello@myrsi.org');
        expect(log.mock.calls[2][1]).toBe('font-size:12px;font-style:italic;color:#9ca3af');
    });

    it('never throws when console.log itself throws', () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('devtools detached'); });
        expect(() => printConsoleBanner()).not.toThrow();
        expect(log).toHaveBeenCalledTimes(1);
    });

    it('does nothing when console.log is not a function', () => {
        vi.stubGlobal('console', { warn: vi.fn(), log: 'disabled' });
        expect(() => printConsoleBanner()).not.toThrow();
    });

    it('does nothing when there is no console at all', () => {
        vi.stubGlobal('console', undefined);
        expect(() => printConsoleBanner()).not.toThrow();
    });
});
