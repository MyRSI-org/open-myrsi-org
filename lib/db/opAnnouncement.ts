// The operation-announcement embed INPUT builder.
//
// WHY IT LIVES HERE and not in api/actions/operations.ts, where it started: the
// start-notice cron job (lib/db/opStartNotices.ts) needs the same input, and a
// lib/ module must not import from api/actions/** — that inverts the layering and
// api/actions/operations.ts already imports lib/db.js, so the cycle would be real.
//
// DELIBERATELY NOT IN THE lib/db.ts BARREL, for the same reason opReminders.ts is
// not: this module imports getOrgTenantUrl FROM the barrel, so re-exporting it back
// out of the barrel would close a runtime cycle. Both consumers import it directly.
//
// EGRESS. Everything this builds is destined for a GENERAL Discord channel with no
// per-recipient clearance or marker filter, so the `restricted` flag it returns is
// the whole security contract: when true, the embed builder drops every sensitive
// field and posts a bare notice. The flag comes from operationIsRestricted — the ONE
// definition, which is fail-closed and includes is_special — never from an inline
// re-derivation. Hosted computes it inline from clearance + markers only, which
// silently un-restricts every clearance-0 Special Operation.

import { supabase } from './common.js';
import { operationIsRestricted } from './ops.js';
import { getOrgTenantUrl } from '../db.js';
import { log as baseLog } from '../log.js';
import type { OperationAnnouncementEmbedInput } from '../discord.js';

const log = baseLog.child({ module: 'db.opAnnouncement' });

interface SupabaseLikeError {
    code?: string;
    message?: string;
    hint?: string;
    details?: string;
}

/** Row shape pulled by buildAnnouncementEmbedInput's `operations` select. */
interface OperationEmbedRow {
    id: string;
    name: string;
    description: string | null;
    type: string;
    scheduled_start: string | null;
    scheduled_end: string | null;
    clearance_level: number | null;
    unit_id: number | null;
    location_id: number | null;
    location_text?: string | null;
}

/** Branding settings blob the embed pulls name + iconUrl off. */
interface BrandingConfig {
    name?: string;
    iconUrl?: string;
}

// Builds the embed payload for an operation announcement. Pulls branding +
// clearance label + unit name + location text from the DB so the Discord embed
// is self-contained (Discord viewers don't have to click through for context).
export async function buildAnnouncementEmbedInput(operationId: string): Promise<OperationAnnouncementEmbedInput | null> {
    // Base columns are guaranteed to exist on every deployed schema. `location_text`
    // is from migrations/add-operations-location-text.sql; embedded joins on
    // `units` and `locations` rely on PostgREST's FK inference and its schema
    // cache. Pull each optional bit separately so a missing column / stale cache
    // / FK ambiguity degrades the embed instead of blanking it.
    const baseSelect = 'id, name, description, type, scheduled_start, scheduled_end, clearance_level, unit_id, location_id';
    const initial = await supabase
        .from('operations')
        .select(`${baseSelect}, location_text`)
        .eq('id', operationId)
        .single();
    let op = initial.data as OperationEmbedRow | null;
    let opErr = initial.error as SupabaseLikeError | null;

    // Fallback: location_text column not yet present (migration not applied or
    // PostgREST cache stale). Same error codes the createOperation fallback uses.
    const code = opErr?.code;
    if (opErr && (code === '42703' || code === 'PGRST204')) {
        log.warn('operations.location_text unavailable — retrying without', { code, hint: 'run migrations/add-operations-location-text.sql' });
        const retry = await supabase
            .from('operations')
            .select(baseSelect)
            .eq('id', operationId)
            .single();
        op = retry.data as OperationEmbedRow | null;
        opErr = retry.error as SupabaseLikeError | null;
    }

    if (opErr || !op) {
        if (opErr) log.error('operation lookup failed', { operationId, code: opErr.code, message: opErr.message, hint: opErr.hint || '', details: opErr.details || '' });
        return null;
    }

    // Empty-branch placeholder when the op has no unit/location FK to resolve.
    // Typed to the subset of the single-row response these reads use
    // ({ data: { name } | null }) so the ternary unifies with the query builder
    // (also PromiseLike) without `any`.
    const emptyNamedRow: Promise<{ data: { name: string } | null; error: null }> =
        Promise.resolve({ data: null, error: null });
    const [unitRes, locationRes, settingsRes] = await Promise.all([
        op.unit_id
            ? supabase.from('units').select('name').eq('id', op.unit_id).maybeSingle()
            : emptyNamedRow,
        op.location_id
            ? supabase.from('locations').select('name').eq('id', op.location_id).maybeSingle()
            : emptyNamedRow,
        supabase.from('settings')
            .select('key, value')
            .in('key', ['brandingConfig']),
    ]);
    const settingsRows = (settingsRes.data || []) as Array<{ key: string; value: unknown }>;
    const branding = (settingsRows.find((r) => r.key === 'brandingConfig')?.value as BrandingConfig | undefined) || {};

    let clearanceLabel: string | null = null;
    if (typeof op.clearance_level === 'number' && op.clearance_level > 0) {
        const { data: clearance } = await supabase
            .from('security_clearances')
            .select('name, level')
            .eq('level', op.clearance_level)
            .maybeSingle();
        clearanceLabel = clearance?.name ? `L${clearance.level} — ${clearance.name}` : `Level ${op.clearance_level}`;
    }

    // EGRESS GATE: the announcement channel is a GENERAL channel with no
    // per-recipient clearance/marker filter, so a restricted op posts a bare
    // notice; the full embed is reserved for level-0, marker-free, non-special
    // ops. The shared predicate (fail-closed on any probe fault) is the ONE
    // definition — see lib/db/ops.ts operationIsRestricted.
    const restricted = await operationIsRestricted(operationId);

    const unitName = unitRes.data?.name || null;
    const locationLabel = (op.location_text && String(op.location_text).trim())
        || locationRes.data?.name
        || null;

    const tenantUrl = await getOrgTenantUrl();
    const operationDeepLink = tenantUrl ? `${tenantUrl.replace(/\/$/, '')}/operations/${operationId}` : null;

    return {
        name: op.name,
        description: op.description,
        type: op.type,
        scheduledStart: op.scheduled_start,
        scheduledEnd: op.scheduled_end,
        clearanceLabel,
        unitName,
        locationLabel,
        operationDeepLink,
        branding: { name: branding?.name, iconUrl: branding?.iconUrl },
        // When restricted the builder drops every sensitive field above (name +
        // deep link only). They still ride the input so the type stays one shape.
        restricted,
    };
}
