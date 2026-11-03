import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

// The Database Tools health report is where the boot guards' non-fatal findings (a weak
// JWT_SECRET, an unrecognised SUPABASE_ANON_KEY, schema drift) reach an admin. The server
// sends the fix instruction as `action`, but the tab used to render only the check text and
// "Records: <count>" — so the instruction was invisible and configuration rows read
// "Records: null".

import { HealthCheckRow } from '../components/views/admin/HealthCheckRow';

describe('HealthCheckRow', () => {
    it('shows the fix instruction on a WARNING', () => {
        const { container } = render(<HealthCheckRow item={{ check: 'Session Secret (JWT_SECRET identical to SUPABASE_SERVICE_ROLE_KEY)', status: 'WARNING', count: null, action: 'Rotate JWT_SECRET when convenient: see Rotating the session secret in DEPLOYMENT_GUIDE.md' }} />);
        expect(container.textContent).toContain('Rotate JWT_SECRET when convenient');
        expect(container.textContent).toContain('WARNING');
    });

    it('shows the fix instruction on an ERROR', () => {
        const { container } = render(<HealthCheckRow item={{ check: 'Schema Version (found 15.7.0-open, expected 15.7.1-open)', status: 'WARNING', count: null, action: 'Re-run schema.sql' }} />);
        expect(container.textContent).toContain('Re-run schema.sql');
        const err = render(<HealthCheckRow item={{ check: 'Secret Encryption (2 encrypted value(s), no key configured)', status: 'ERROR', count: 2, action: 'Set SECRETS_ENCRYPTION_KEY and restart' }} />);
        expect(err.container.textContent).toContain('Set SECRETS_ENCRYPTION_KEY and restart');
        expect(err.container.textContent).toContain('ERROR');
    });

    it('does not show an action on an OK row', () => {
        const { container } = render(<HealthCheckRow item={{ check: 'Session Secret', status: 'OK', count: null, action: 'should not render' }} />);
        expect(container.textContent).not.toContain('should not render');
    });

    it('prints a record count only when there is one', () => {
        const config = render(<HealthCheckRow item={{ check: 'Session Secret', status: 'OK', count: null }} />);
        expect(config.container.textContent).not.toContain('Records');
        expect(config.container.textContent).not.toContain('null');
        const counted = render(<HealthCheckRow item={{ check: 'Total Intel Reports', status: 'OK', count: 0 }} />);
        expect(counted.container.textContent).toContain('Records: 0');
    });
});
