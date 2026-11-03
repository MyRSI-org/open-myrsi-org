import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

// The changelog card for the CURRENT release, rendered. tests/schemaVersionParity.test.ts
// pins the source (exactly one isLatest card, at EXPECTED_SCHEMA_VERSION); this checks
// what a member actually sees: the current card is the first one on the page, it carries
// the Current Release badge and its release date, and the card that held the badge
// before has dropped it.

import ChangeLogView from '../components/views/help/ChangeLogView';
import { EXPECTED_SCHEMA_VERSION } from '../lib/schemaVersion';

describe('ChangeLogView — the current release card', () => {
    const cards = () => Array.from(render(<ChangeLogView onBack={() => {}} />).container.querySelectorAll('section'));

    it('is the first card, at the expected version, badged and dated', () => {
        const [first] = cards();
        expect(first.querySelector('h2')?.textContent).toBe(`Version ${EXPECTED_SCHEMA_VERSION}`);
        expect(first.textContent).toContain('Current Release');
        expect(first.textContent).toContain('Released 2 Nov 2026 · Archive ID:');
    });

    it('no other card claims to be the current release, and undated cards show no date', () => {
        const [, ...rest] = cards();
        expect(rest.length).toBeGreaterThan(0);
        for (const card of rest) {
            expect(card.textContent).not.toContain('Current Release');
            expect(card.textContent).not.toContain('Released ');
        }
        // The previous release is still there, now in the history.
        expect(rest[0].querySelector('h2')?.textContent).toBe('Version 15.7.0-open');
    });
});
