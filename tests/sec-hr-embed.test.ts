import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toHydratedInterview, toTransferRequest, toHydratedApplication } from '../lib/db/mappers';

// PII over-select on HR foreign-table user-embeds: they must not SELECT the
// users.discord_id column. The `hr` / hr_interviews / hr_applicants query subsets
// are gated only by `hr:view` (which the seeded Member role holds), so those rows
// reach every Member. discord_id stays out of view because every consumer maps the
// embed through toMiniUser -> blankSensitiveUserFields (which sets discordId:''),
// but that relies on the embeds NOT selecting sensitive columns. discord_id is
// therefore dropped from every HR user-embed in lib/db/hr.ts (assignedRecruiter,
// panel user, interviewer, app-log user, my-interview interviewer, transfer user)
// so the minimization is enforced at the SELECT, not just incidentally at the mapper.

// A users-table embed row simulating a *widened* SELECT that leaks every
// sensitive column (incl. discord_id). The mapper must blank it regardless,
// and (separately) the SELECT must not request it in the first place.
const leakyUserEmbed = () => ({
    id: 101,
    name: 'jenko',
    display_name: null,
    avatar_url: 'https://cdn.discordapp.com/avatars/123/abc.png',
    role_id: 2,
    discord_id: '101953620311810048',
    rsi_handle: 'Jenko',
    admin_notes: 'secret admin note',
    personnel_notes: 'secret hr note',
    clearance_level: 5,
    limiting_markers: [{ marker: 'NOFORN' }],
    role: { name: 'Member', role_permissions: [{ permission: { name: 'hr:view' } }] },
});

describe('HR embed discord_id minimization', () => {
    // --- Blanking-contract backstop (mirrors embedPiiMinimization.test.ts):
    // even if a future SELECT re-widens, the mapped embed must never carry
    // discord_id, while public identity (name / rsi handle) is preserved.

    it('interview interviewer + panel members keep identity but blank discord_id', () => {
        const interview: any = toHydratedInterview({
            id: 'i1', application_id: 'a1', template_id: 1, interviewer_id: 101,
            scheduled_at: 'now', status: 'Scheduled',
            interviewer: leakyUserEmbed(),
            panel: [{ user: leakyUserEmbed() }],
            responses: [],
        } as any);

        expect(interview.interviewer.name).toBe('jenko'); // identity preserved
        expect(interview.interviewer.discordId).toBe('');
        expect(interview.panelMembers[0].name).toBe('jenko');
        expect(interview.panelMembers[0].discordId).toBe('');
    });

    it('transfer request user blanks discord_id', () => {
        const tr = toTransferRequest({
            id: 't1', user_id: 101, current_unit_id: 1, target_unit_id: 2,
            reason: 'x', status: 'Pending', admin_notes: null, created_at: 'now', updated_at: 'now',
            user: leakyUserEmbed(),
            targetUnit: { id: 2, name: 'Unit', parent_unit_id: null, sort_order: 0 },
        } as any);

        expect(tr.user?.name).toBe('jenko');
        expect(tr.user?.discordId).toBe('');
    });

    it('application assignedRecruiter blanks discord_id but keeps the applicant own discord id (a plain rendered column)', () => {
        const app = toHydratedApplication({
            id: 'a1', applicant_name: 'X', applicant_discord_id: '999', rsi_handle: 'X',
            status: 'New', assigned_recruiter_id: 101, created_at: 'now',
            assignedRecruiter: leakyUserEmbed(),
            interviews: [],
        } as any);

        expect(app.assignedRecruiter?.discordId).toBe('');
        // applicant_discord_id is a distinct plain column on hr_applications that
        // the HR UI renders — it must survive the minimization untouched.
        expect(app.applicantDiscordId).toBe('999');
    });

    // --- Regression guard locking the SELECT-level minimization. Any HR users(...)
    // foreign-table embed that re-adds discord_id (re-introducing the leak) fails
    // here. (`applicant_discord_id`, the plain column, is not inside a users(...)
    // embed, so it is unaffected.)
    it('no users(...) embed in lib/db/hr.ts selects discord_id', () => {
        const src = readFileSync(resolve(__dirname, '..', 'lib', 'db', 'hr.ts'), 'utf8');
        // Match `users(...)` and `users!fk_name(...)` PostgREST embeds, capturing
        // the column list. Does NOT match `from('users')` direct table selects.
        const embedRe = /users(?:![A-Za-z0-9_]+)?\(([^)]*)\)/g;
        const offenders: string[] = [];
        let embedCount = 0;
        let m: RegExpExecArray | null;
        while ((m = embedRe.exec(src)) !== null) {
            embedCount++;
            if (/\bdiscord_id\b/.test(m[1])) offenders.push(m[0]);
        }
        // Sanity: the regex actually found the HR user-embeds (guards against a
        // vacuous pass if the embed shape ever changes).
        expect(embedCount).toBeGreaterThan(0);
        expect(offenders, `HR user-embed(s) still select discord_id:\n${offenders.join('\n')}`).toEqual([]);
    });
});
