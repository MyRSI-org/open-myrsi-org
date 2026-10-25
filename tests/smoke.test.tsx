import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import App from '../App';

// Mock the Supabase client and other contexts if necessary
// But for a true smoke test, we want to see if it even MOUNTS.
// Since App uses lazy loading and suspense, we expect to see the splash screen fallback

describe('App Smoke Test', () => {
    it('renders the splash screen when on a tenant subdomain', async () => {
        // Mock window.location
        Object.defineProperty(window, 'location', {
            value: {
                hostname: 'alpha.myrsi.org',
                href: 'https://alpha.myrsi.org',
                origin: 'https://alpha.myrsi.org'
            },
            writable: true
        });

        render(<App />);
        // Should show the splash screen because it enters the Suspense boundary for DashboardApp
        const loadingElement = await screen.findByText(/Establishing Uplink/i);
        // Plain-DOM form of jest-dom's toBeInTheDocument (dropped with jest-dom on the vitest 5 move).
        expect(document.body.contains(loadingElement)).toBe(true);
    });
});
