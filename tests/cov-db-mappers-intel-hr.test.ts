import { describe, it, expect } from 'vitest';
import {
    toHydratedWarrant, toHydratedIntelReport, toIntelBulletin, toHydratedApplication,
    toHRInterviewTemplate, toJobPosting, toHydratedInterview, toTransferRequest, toWikiPage,
    toReputationHistoryEntry, toRatingHistoryEntry, toServiceTypeConfig,
} from '../lib/db/mappers';
import { ROSTER_SAFE_FIELDS } from '../lib/db/userFilters';
import { UserRole } from '../types';

// lib/db/mappers.ts — warrant / intel / HR / wiki / reputation mappers. These carry
// the clearance + limiting-marker fields lib/clearance.ts filters on, so a dropped or
// mis-defaulted classificationLevel here would silently widen visibility: every
// classification default is pinned, and every embedded author is minified.

const MINI_KEYS = [...new Set([...ROSTER_SAFE_FIELDS, 'discordId', 'permissions', 'conductRecord', 'limitingMarkers'])].sort();

function secretUserRow(id: number, name: string): Record<string, unknown> {
    return {
        id, name, discord_id: '990000000000000001', avatar_url: `${name}.png`,
        role: { id: 9, name: 'Admin', role_permissions: [{ permission: { name: 'admin:access' } }] },
        admin_notes: 'SECRET-admin', personnel_notes: 'SECRET-personnel', rsi_verification_code: 'SECRET-code',
        job_title: 'SECRET-job', clearance_level: { level: 5, name: 'SECRET-cl' }, limiting_markers: [{ marker: 'SECRET-m' }],
    };
}

function expectMiniUser(u: unknown, id: number, name: string) {
    expect(u).toBeDefined();
    const rec = u as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(MINI_KEYS);
    expect(rec.id).toBe(id);
    expect(rec.name).toBe(name);
    expect(rec.discordId).toBe('');
    expect(rec.permissions).toEqual([]);
    expect(JSON.stringify(rec)).not.toContain('SECRET');
}

const UNKNOWN_USER = {
    id: 0, discordId: '', name: 'Unknown Agent', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
    rsiHandle: 'Unknown', role: UserRole.Client, roleId: 1, reputation: 0, isDuty: false, permissions: [],
    createdAt: expect.any(String),
};

describe('toHydratedWarrant', () => {
    const cols = {
        id: 'w1', target_rsi_handle: 'Pirate', reason: 'piracy', action: 'KOS', uec_reward: 1000, status: 'Active',
        claimed_by: 12, source_feed_id: 'feed-1', external_id: 'ext-1', notes: 'n', created_at: 'c',
    };

    it('maps a full row with minified issuer/claimer and the feed label only', () => {
        const w = toHydratedWarrant({
            ...cols, issued_by: 11, issuedBy: secretUserRow(11, 'Issuer'), claimedBy: secretUserRow(12, 'Claimer'),
            feed: { label: 'Ally feed', id: 'LEAK-feed-id', api_key: 'LEAK' }, secret_LEAK: 1,
        } as never);
        expectMiniUser(w.issuedByUser, 11, 'Issuer');
        expectMiniUser(w.claimedByUser, 12, 'Claimer');
        expect(w).toStrictEqual({
            id: 'w1', targetRsiHandle: 'Pirate', reason: 'piracy', action: 'KOS', uecReward: 1000, status: 'Active',
            issuedBy: 11, claimedBy: 12, sourceFeedId: 'feed-1', externalId: 'ext-1', notes: 'n', issuedAt: 'c',
            issuedByUser: w.issuedByUser, claimedByUser: w.claimedByUser, sourceFeedLabel: 'Ally feed',
        });
    });

    it('a feed-imported warrant with no local issuer gets issuedBy null and the Unknown Agent card', () => {
        const w = toHydratedWarrant({ ...cols, issued_by: undefined, issuedBy: null, claimedBy: null, feed: null } as never);
        expect(w.issuedBy).toBeNull();
        expect(w.issuedByUser).toStrictEqual(UNKNOWN_USER);
        expect(w.claimedByUser).toBeUndefined();
        expect(w.sourceFeedLabel).toBeUndefined();
    });
});

describe('toHydratedIntelReport', () => {
    it('maps a full row, markers flattened, author minified', () => {
        const r = toHydratedIntelReport({
            id: 'r1', target_id: 'Pirate', subject_type: 'Person', threat_level: 'High', tags: ['a'], summary: 's',
            evidence_urls: ['https://e'], createdBy: secretUserRow(11, 'Analyst'), external_author: 'ext',
            affiliated_org: 'ORG', feed: { label: 'Feed' }, created_at: 'c', classification_level: 4,
            intel_report_limiting_markers: [{ marker: 'NOFORN' }, { marker: null }, { marker: 'ORCON' }],
            created_by_id: 'LEAK', secret_LEAK: 1,
        } as never);
        expectMiniUser(r.createdBy, 11, 'Analyst');
        expect(r).toStrictEqual({
            id: 'r1', targetId: 'Pirate', subjectType: 'Person', threatLevel: 'High', tags: ['a'], summary: 's',
            evidenceUrls: ['https://e'], createdBy: r.createdBy, externalAuthor: 'ext', affiliatedOrg: 'ORG',
            sourceFeedLabel: 'Feed', createdAt: 'c', classificationLevel: 4, limitingMarkers: ['NOFORN', 'ORCON'],
        });
    });

    it('a sparse row defaults to UNCLASSIFIED with no markers, tags or evidence', () => {
        expect(toHydratedIntelReport({
            id: 'r2', target_id: 't', subject_type: 'Org', threat_level: 'Low', tags: null, summary: 's',
            evidence_urls: null, created_at: 'c', classification_level: null,
        } as never)).toStrictEqual({
            id: 'r2', targetId: 't', subjectType: 'Org', threatLevel: 'Low', tags: [], summary: 's', evidenceUrls: [],
            createdBy: undefined, externalAuthor: undefined, affiliatedOrg: undefined, sourceFeedLabel: undefined,
            createdAt: 'c', classificationLevel: 0, limitingMarkers: [],
        });
    });
});

describe('toIntelBulletin', () => {
    it('maps a full row including federation provenance', () => {
        const b = toIntelBulletin({
            id: 'b1', title: 'T', body: 'B', threat_level: 'High', location: 'Yela', duration_minutes: 60,
            expires_at: 'e', classification_level: 2, intel_bulletin_limiting_markers: [{ marker: 'REL' }, { marker: '' }],
            created_by_id: 11, createdBy: secretUserRow(11, 'Author'), created_at: 'c', shared_with_allies: true,
            source_organization_id: 'org-2', source_bulletin_id: 'b-remote', source_organization_name: 'Allies',
            secret_LEAK: 1,
        } as never);
        expectMiniUser(b.createdByUser, 11, 'Author');
        expect(b).toStrictEqual({
            id: 'b1', title: 'T', body: 'B', threatLevel: 'High', location: 'Yela', durationMinutes: 60, expiresAt: 'e',
            classificationLevel: 2, limitingMarkers: ['REL'], createdById: 11, createdByUser: b.createdByUser,
            createdAt: 'c', sharedWithAllies: true, sourceOrganizationId: 'org-2', sourceBulletinId: 'b-remote',
            sourceOrganizationName: 'Allies',
        });
    });

    it('a sparse local bulletin is unclassified, unshared, with null provenance', () => {
        expect(toIntelBulletin({
            id: 'b2', title: 'T', body: 'B', threat_level: 'Low', location: '', duration_minutes: 30, expires_at: 'e',
            classification_level: null, created_by_id: 11, created_at: 'c', shared_with_allies: null,
            source_organization_id: null, source_bulletin_id: null, source_organization_name: null,
        } as never)).toStrictEqual({
            id: 'b2', title: 'T', body: 'B', threatLevel: 'Low', location: null, durationMinutes: 30, expiresAt: 'e',
            classificationLevel: 0, limitingMarkers: [], createdById: 11, createdByUser: undefined, createdAt: 'c',
            sharedWithAllies: false, sourceOrganizationId: null, sourceBulletinId: null, sourceOrganizationName: null,
        });
    });
});

describe('HR mappers', () => {
    const TEMPLATE_ROW = {
        id: 3, name: 'Standard', description: 'desc', created_at: 'LEAK',
        questions: [{ id: 1, template_id: 3, question_text: 'Why?', order_index: 0, created_at: 'LEAK' }],
    };
    const TEMPLATE_OUT = { id: 3, name: 'Standard', description: 'desc', questions: [{ id: 1, templateId: 3, questionText: 'Why?', orderIndex: 0 }] };
    const UNKNOWN_TEMPLATE = { id: 0, name: 'Unknown', description: '', questions: [] };

    it('toHRInterviewTemplate maps questions and defaults a missing join to []', () => {
        expect(toHRInterviewTemplate(TEMPLATE_ROW as never)).toStrictEqual(TEMPLATE_OUT);
        expect(toHRInterviewTemplate({ id: 4, name: 'N', description: null, questions: null } as never))
            .toStrictEqual({ id: 4, name: 'N', description: null, questions: [] });
    });

    it('toHydratedInterview maps a full row: minified interviewer + panel, template, responses', () => {
        const i = toHydratedInterview({
            id: 'i1', application_id: 'a1', template_id: 3, template: TEMPLATE_ROW, interviewer_id: 11,
            interviewer: secretUserRow(11, 'Interviewer'),
            panel: [{ user: secretUserRow(12, 'Panelist') }, { user: null }],
            scheduled_at: 's', completed_at: 'done', overall_notes: 'notes', final_score: 8, status: 'Completed',
            is_recommended: true, responses: [{ question_id: 1, response_body: 'Because', score: 4, interviewer_private: 'LEAK' }],
            secret_LEAK: 1,
        } as never);
        expectMiniUser(i.interviewer, 11, 'Interviewer');
        expect(i.panelMembers).toHaveLength(1);
        expectMiniUser(i.panelMembers[0], 12, 'Panelist');
        expect(i).toStrictEqual({
            id: 'i1', applicationId: 'a1', templateId: 3, template: TEMPLATE_OUT, interviewerId: 11,
            interviewer: i.interviewer, panelMembers: i.panelMembers, scheduledAt: 's', completedAt: 'done',
            overallNotes: 'notes', finalScore: 8, status: 'Completed', isRecommended: true,
            responses: [{ questionId: 1, responseBody: 'Because', score: 4 }],
        });
    });

    it('toHydratedInterview defaults the un-joined relations', () => {
        expect(toHydratedInterview({
            id: 'i2', application_id: 'a1', template_id: 3, interviewer_id: 11, scheduled_at: 's', status: 'Scheduled',
        } as never)).toStrictEqual({
            id: 'i2', applicationId: 'a1', templateId: 3, template: UNKNOWN_TEMPLATE, interviewerId: 11,
            interviewer: UNKNOWN_USER, panelMembers: [], scheduledAt: 's', completedAt: undefined,
            overallNotes: undefined, finalScore: undefined, status: 'Scheduled', isRecommended: undefined, responses: [],
        });
    });

    it('toHydratedInterview returns a placeholder for a missing/non-object row', () => {
        const placeholder = {
            id: '0', applicationId: '0', templateId: 0, template: UNKNOWN_TEMPLATE, interviewerId: 0,
            interviewer: UNKNOWN_USER, panelMembers: [], scheduledAt: expect.any(String), status: 'Scheduled', responses: [],
        };
        expect(toHydratedInterview(null)).toStrictEqual(placeholder);
        expect(toHydratedInterview(undefined)).toStrictEqual(placeholder);
        expect(toHydratedInterview('x' as never)).toStrictEqual(placeholder);
    });

    it('toHydratedApplication maps the row, minifies the recruiter, maps joined interviews, never ships logs', () => {
        const a = toHydratedApplication({
            id: 'a1', applicant_name: 'Recruit', applicant_discord_id: '1234', rsi_handle: 'rec', status: 'Pending',
            referral_source: 'friend', notes: 'n', assigned_recruiter_id: 11, assignedRecruiter: secretUserRow(11, 'Recruiter'),
            linked_user_id: 20, created_at: 'c', vetting_data: { ok: true },
            interviews: [{ id: 'i9', application_id: 'a1', template_id: 3, interviewer_id: 11, scheduled_at: 's', status: 'Scheduled' }],
            secret_LEAK: 1,
        } as never);
        expectMiniUser(a.assignedRecruiter, 11, 'Recruiter');
        expect(a).toStrictEqual({
            id: 'a1', applicantName: 'Recruit', applicantDiscordId: '1234', rsiHandle: 'rec', status: 'Pending',
            referralSource: 'friend', notes: 'n', assignedRecruiterId: 11, assignedRecruiter: a.assignedRecruiter,
            linkedUserId: 20, createdAt: 'c', interviews: [expect.objectContaining({ id: 'i9', template: UNKNOWN_TEMPLATE })],
            vettingData: { ok: true }, logs: [],
        });
        const bare = toHydratedApplication({ id: 'a2', applicant_name: 'X', status: 'Pending', created_at: 'c' } as never);
        expect(bare.assignedRecruiter).toBeUndefined();
        expect(bare.interviews).toEqual([]);
        expect(bare.logs).toEqual([]);
    });

    it('toJobPosting maps the row and the optional position join', () => {
        expect(toJobPosting({
            id: 'j1', title: 'Pilot', department: 'Flight', description: 'd', requirements: 'r', status: 'Open',
            created_at: 'c', position_id: 5, position: { id: 5, name: 'Pilot', description: null, icon: null, department: 'Flight' },
            created_by: 'LEAK',
        } as never)).toStrictEqual({
            id: 'j1', title: 'Pilot', department: 'Flight', description: 'd', requirements: 'r', status: 'Open',
            createdAt: 'c', positionId: 5, position: { id: 5, name: 'Pilot', description: null, icon: null, department: 'Flight' },
        });
        expect(toJobPosting({ id: 'j2', title: 'T', department: 'D', description: 'd', requirements: 'r', status: 'Closed', created_at: 'c', position_id: null } as never).position)
            .toBeUndefined();
    });

    it('toTransferRequest maps the row, minifies the user and maps the target unit', () => {
        const t = toTransferRequest({
            id: 't1', user_id: 11, current_unit_id: 1, target_unit_id: 4, reason: 'r', status: 'Pending',
            admin_notes: 'an', created_at: 'c', updated_at: 'u', user: secretUserRow(11, 'Mover'),
            targetUnit: { id: 4, name: 'Alpha', sort_order: 1 }, secret_LEAK: 1,
        } as never);
        expectMiniUser(t.user, 11, 'Mover');
        expect(t).toStrictEqual({
            id: 't1', userId: 11, currentUnitId: 1, targetUnitId: 4, reason: 'r', status: 'Pending', adminNotes: 'an',
            createdAt: 'c', updatedAt: 'u', user: t.user, targetUnit: expect.objectContaining({ id: 4, name: 'Alpha' }),
        });
        const bare = toTransferRequest({ id: 't2', user_id: 1, target_unit_id: 2, status: 'Pending', created_at: 'c', updated_at: 'u' } as never);
        expect(bare.user).toBeUndefined();
        expect(bare.targetUnit).toBeUndefined();
    });
});

describe('toWikiPage', () => {
    it('maps a full row, markers flattened, authors minified', () => {
        const p = toWikiPage({
            id: 'p1', parent_page_id: 'p0', title: 'Doctrine', slug: 'doctrine', content: { type: 'doc' },
            classification_level: 3, sort_order: 2, wiki_page_limiting_markers: [{ marker: 'NF' }, { marker: null }],
            created_by_id: 11, updated_by_id: 12, createdBy: secretUserRow(11, 'Writer'), updatedBy: secretUserRow(12, 'Editor'),
            created_at: 'c', updated_at: 'u', menu_structure_locked: true, secret_LEAK: 1,
        } as never);
        expectMiniUser(p.createdBy, 11, 'Writer');
        expectMiniUser(p.updatedBy, 12, 'Editor');
        expect(p).toStrictEqual({
            id: 'p1', parentPageId: 'p0', title: 'Doctrine', slug: 'doctrine', content: { type: 'doc' },
            classificationLevel: 3, sortOrder: 2, limitingMarkers: ['NF'], createdById: 11, updatedById: 12,
            createdBy: p.createdBy, updatedBy: p.updatedBy, createdAt: 'c', updatedAt: 'u', menuStructureLocked: true,
        });
    });

    it('a sparse row is an unclassified, unlocked root page', () => {
        expect(toWikiPage({
            id: 'p2', parent_page_id: null, title: 'T', slug: 's', content: null, classification_level: null,
            sort_order: null, created_by_id: null, updated_by_id: null, created_at: 'c', updated_at: 'u', menu_structure_locked: null,
        } as never)).toStrictEqual({
            id: 'p2', parentPageId: null, title: 'T', slug: 's', content: {}, classificationLevel: 0, sortOrder: 0,
            limitingMarkers: [], createdById: null, updatedById: null, createdBy: undefined, updatedBy: undefined,
            createdAt: 'c', updatedAt: 'u', menuStructureLocked: undefined,
        });
    });
});

describe('reputation / rating / service-type mappers', () => {
    it('toReputationHistoryEntry minifies the admin, or falls back to the Unknown Agent', () => {
        const e = toReputationHistoryEntry({
            id: 1, user_id: 5, admin_user_id: 11, adminUser: secretUserRow(11, 'Admin'), change_date: 'd',
            old_reputation: 1, new_reputation: 2, reason: 'r', secret_LEAK: 1,
        } as never);
        expectMiniUser(e.adminUser, 11, 'Admin');
        expect(e).toStrictEqual({ id: 1, userId: 5, adminUserId: 11, adminUser: e.adminUser, changeDate: 'd', oldReputation: 1, newReputation: 2, reason: 'r' });
        expect(toReputationHistoryEntry({ id: 2, user_id: 5, admin_user_id: null, adminUser: null, change_date: 'd', old_reputation: 0, new_reputation: 0, reason: null } as never).adminUser)
            .toStrictEqual(UNKNOWN_USER);
    });

    it('toRatingHistoryEntry exposes only the client handle, never the client row', () => {
        expect(toRatingHistoryEntry({
            id: 'req-1', service_type: 'Medical', client_rating: 4, updated_at: 'u', client_feedback: 'LEAK-feedback',
            client: { rsi_handle: 'Customer', discord_id: 'LEAK-discord' },
        } as never)).toStrictEqual({ requestId: 'req-1', serviceType: 'Medical', clientRating: 4, date: 'u', clientRsiHandle: 'Customer', rating: 4 });
        expect(toRatingHistoryEntry({ id: 'req-2', service_type: 'S', client_rating: 3, updated_at: 'u', client: null } as never).clientRsiHandle).toBe('Unknown');
        expect(toRatingHistoryEntry({ id: 'req-3', service_type: 'S', client_rating: 3, updated_at: 'u', client: { rsi_handle: null } } as never).clientRsiHandle).toBe('Unknown');
    });

    it('toServiceTypeConfig maps the routing snowflake only when set', () => {
        expect(toServiceTypeConfig({
            id: 1, name: 'Security', icon: 'fa-shield', color: '#fff', description: 'd', is_active: true,
            discord_channel_id: '111222333444555666', created_at: 'LEAK',
        } as never)).toStrictEqual({
            id: 1, name: 'Security', icon: 'fa-shield', color: '#fff', description: 'd', isActive: true, discordChannelId: '111222333444555666',
        });
        expect(toServiceTypeConfig({ id: 2, name: 'Salvage', icon: 'i', color: 'c', description: null, is_active: false, discord_channel_id: null } as never))
            .toStrictEqual({ id: 2, name: 'Salvage', icon: 'i', color: 'c', description: null, isActive: false, discordChannelId: undefined });
    });
});
