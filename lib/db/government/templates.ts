
import { supabase, handleSupabaseError } from '../common.js';
import { broadcastGovernmentUpdate, GOVERNMENT_TEMPLATES } from './internal.js';
import { upsertGovernmentConfig, getGovernmentState } from './structure.js';

export function getGovernmentTemplates() {
    return GOVERNMENT_TEMPLATES;
}

const isPgCode = (error: unknown, code: string) => (error as { code?: string } | null)?.code === code;

function ordersBlockMessage(count: number | null): string {
    const onRecord = count == null ? 'Executive orders are' : `${count} executive order${count === 1 ? ' is' : 's are'}`;
    return `Cannot apply a template: ${onRecord} on record. Every order — draft, in force, expired or revoked — stays tied to the office that issued it, and applying a template deletes every position, so it is refused while any order exists. Change the structure position by position instead.`;
}

function nameTakenMessage(kind: 'branch' | 'position', name: string): string {
    return `Cannot apply the template: a ${kind} named "${name}" already exists. The template was only partly applied — apply it again.`;
}

/**
 * Replace the whole government structure with a template.
 *
 * This used to delete only the BRANCHES, with no filter and the error ignored.
 * government_positions.branch_id is ON DELETE SET NULL, so every position survived,
 * branch-less but still held — and its holders KEPT their veto, legislative-vote and
 * order-issuing powers while the UI showed a fresh structure. The template's own seats
 * then collided with the survivors on UNIQUE(name) and were silently dropped (the
 * insert errors were ignored too), so a "Senator" seat simply never appeared.
 *
 * Now, in order, every step checked:
 *   1. Refuse while any executive order exists. government_orders.issuer_position_id is
 *      ON DELETE RESTRICT, so the position delete would fail on it anyway; this says why
 *      before anything is touched. (A count that cannot be read refuses as well.)
 *   2. Delete every position — the cascade removes their holders (what the confirm
 *      dialog promises) and, with them, the elections for those seats and the
 *      legislation votes cast from them.
 *   3. Delete every branch.
 *   4. Write the config, then build each branch and its positions. A name collision
 *      (only possible if something was created concurrently) refuses with the name
 *      rather than silently dropping the seat.
 * Both bulk deletes carry an explicit always-true filter: a DELETE with no WHERE clause
 * is refused outright where pg-safeupdate is loaded.
 *
 * Not atomic — PostgREST gives no multi-statement transaction here — so a failure after
 * step 2 leaves a partial structure. The error says so, and the wholesale broadcast
 * still goes out so every client refetches what is actually there.
 */
export async function applyGovernmentTemplate(templateType: string) {
    const template = GOVERNMENT_TEMPLATES.find(t => t.type === templateType);
    if (!template) throw new Error(`Unknown government template: ${templateType}`);

    const { count: orderCount, error: orderErr } = await supabase.from('government_orders')
        .select('id', { count: 'exact', head: true });
    handleSupabaseError({ error: orderErr, message: 'Failed to check for executive orders' });
    if (orderCount == null) throw new Error('Could not verify whether any executive orders exist — try again.');
    if (orderCount > 0) throw new Error(ordersBlockMessage(orderCount));

    let mutated = false;
    try {
        const { error: positionsErr } = await supabase.from('government_positions')
            .delete().not('id', 'is', null);
        // 23503 = foreign_key_violation: an order issued between the check and the delete.
        if (isPgCode(positionsErr, '23503')) throw new Error(ordersBlockMessage(null));
        handleSupabaseError({ error: positionsErr, message: 'Failed to remove the current positions' });
        mutated = true;

        const { error: branchesErr } = await supabase.from('government_branches')
            .delete().not('id', 'is', null);
        handleSupabaseError({ error: branchesErr, message: 'Failed to remove the current branches' });

        await upsertGovernmentConfig({
            governmentType: template.type,
            name: template.name,
            description: template.description,
        });

        for (const branchDef of template.branches) {
            const { data: branch, error: branchError } = await supabase.from('government_branches').insert({
                name: branchDef.name,
                branch_type: branchDef.branchType,
                icon: branchDef.icon,
                sort_order: branchDef.sortOrder,
            }).select('id').single();
            if (isPgCode(branchError, '23505')) throw new Error(nameTakenMessage('branch', branchDef.name));
            handleSupabaseError({ error: branchError, message: `Failed to create the "${branchDef.name}" branch — the template was only partly applied` });
            if (!branch) throw new Error(`Failed to create the "${branchDef.name}" branch — the template was only partly applied`);

            for (const posDef of branchDef.positions) {
                const { error: positionError } = await supabase.from('government_positions').insert({
                    branch_id: branch.id,
                    name: posDef.name,
                    fill_method: posDef.fillMethod,
                    term_length_days: posDef.termLengthDays || null,
                    max_holders: posDef.maxHolders,
                    icon: posDef.icon || null,
                    sort_order: posDef.sortOrder,
                    permissions_granted: posDef.permissionsGranted || [],
                    can_propose_legislation: posDef.canProposeLegislation ?? false,
                    can_vote_legislation: posDef.canVoteLegislation ?? false,
                    can_veto_legislation: posDef.canVetoLegislation ?? false,
                    can_call_elections: posDef.canCallElections ?? false,
                });
                if (isPgCode(positionError, '23505')) throw new Error(nameTakenMessage('position', posDef.name));
                handleSupabaseError({ error: positionError, message: `Failed to create the "${posDef.name}" position — the template was only partly applied` });
            }
        }
    } finally {
        if (mutated) broadcastGovernmentUpdate();
    }

    return getGovernmentState();
}
