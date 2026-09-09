import { supabase } from './common.js';
import { cache } from '../cache.js';
import { CLIENT_DEFAULT_PERMS } from '../clientRolePermissions.js';
import { MEMBER_DEFAULT_PERMS, DISPATCHER_DEFAULT_PERMS } from '../roleDefaultPermissions.js';
import { markOptionalModuleDefaultsApplied } from './roleDefaults.js';
import { log as baseLog } from '../log.js';
import type { Tables } from './rows.js';

const log = baseLog.child({ module: 'db.seeder' });

export async function seedInstall() {
    log.info('seeding install (single-org)');

    // 1. Seed Service Types
    const serviceTypes = [
        { name: 'Security', icon: 'fa-solid fa-shield-halved', color: '#38bdf8', description: 'Armed escort and protection services.', is_active: true},
        { name: 'Rescue', icon: 'fa-solid fa-truck-medical', color: '#f87171', description: 'Medical extraction and personnel recovery.', is_active: true},
        { name: 'Logistics', icon: 'fa-solid fa-box-open', color: '#fb923c', description: 'Cargo transport and salvage operations.', is_active: true}
    ];
    // Use Upsert (requires unique (name))
    const { error: stError } = await supabase.from('service_types').upsert(serviceTypes, { onConflict: 'name', ignoreDuplicates: true });
    if (stError) log.error('service types seed failed', { err: stError });

    // 2. Seed Security Clearances
    const clearances = [
        { level: 0, name: 'Unclassified', description: 'Public access level.'},
        { level: 1, name: 'Official', description: 'Internal organization access.'},
        { level: 2, name: 'Official Sensitive', description: 'Operational details and sensitive data.'},
        { level: 3, name: 'Protected', description: 'Command-level strategic information.'},
        { level: 4, name: 'Secret', description: 'High-level executive intelligence.'},
        { level: 5, name: 'Top Secret', description: 'Eyes-only special access programs.'}
    ];
    const { error: scError } = await supabase.from('security_clearances').upsert(clearances, { onConflict: 'level', ignoreDuplicates: true });
    if (scError) log.error('clearances seed failed', { err: scError });

    // 3. Seed Roles & Permissions
    const rolesData = [
        { name: 'Client', description: 'System role. Standard access for creating requests.', is_system: true },
        { name: 'Member', description: 'System role. Operational access for responding to requests.', is_system: true },
        { name: 'Dispatcher', description: 'System role. Management access for triaging and assigning requests.', is_system: true },
        { name: 'Admin', description: 'System role. Full system access.', is_system: true }
    ];

    // Upsert Roles
    const { data: createdRoles, error: rolesError } = await supabase.from('roles')
        .upsert(rolesData, { onConflict: 'name' })
        .select('id');

    if (rolesError || !createdRoles) {
        log.error('roles seed failed', { err: rolesError });
        // Do not throw, try to proceed if roles exist
    }

    // Map Roles to IDs (Fetch all to ensure we have IDs even if upsert ignored)
    const { data: currentRoles } = await supabase.from('roles').select('id, name');
    if (!currentRoles || currentRoles.length === 0) {
        throw new Error('Roles missing after seed attempt.');
    }

    const roleMap = currentRoles.reduce(
        (acc: Record<string, number>, curr: Pick<Tables<'roles'>, 'id' | 'name'>) => ({ ...acc, [curr.name]: curr.id }),
        {} as Record<string, number>
    );

    // Fetch Global Permissions
    const { data: permissions } = await supabase.from('permissions').select('id, name');
    if (!permissions) throw new Error('Failed to fetch global permissions');
    const permMap = permissions.reduce(
        (acc: Record<string, number>, curr: Pick<Tables<'permissions'>, 'id' | 'name'>) => ({ ...acc, [curr.name]: curr.id }),
        {} as Record<string, number>
    );

    const rolePerms: Tables<'role_permissions'>[] = [];

    // Define Permission Sets (single source of truth: lib/roleDefaultPermissions.ts,
    // shared with the one-shot repair backfill so the two cannot drift into two lists)
    const clientPerms = [...CLIENT_DEFAULT_PERMS];
    const memberPerms = [...MEMBER_DEFAULT_PERMS];
    const dispatcherPerms = [...DISPATCHER_DEFAULT_PERMS];
    const adminPerms = permissions.map(p => p.name);

    const assign = (roleName: string, permNames: string[]) => {
        const rId = roleMap[roleName];
        if (!rId) return;
        permNames.forEach(pName => {
            const pId = permMap[pName];
            if (pId) rolePerms.push({ role_id: rId, permission_id: pId });
        });
    };

    // The Member/Dispatcher defaults are a STARTING POINT, not a definition, so seed
    // them only onto a tier that holds nothing yet. seedInstall is re-entered from
    // repairDatabase's catastrophic branch (roleCount < 4, or an Admin role holding
    // < 5 perms — reachable through the Roles UI, which has no floor) and this upsert
    // is purely additive, so without the freshness check a Repair click would restore
    // every default the operator had deliberately revoked. Admin keeps its
    // unconditional grant — that branch fires precisely BECAUSE Admin is short — and
    // Client keeps its, since repair clamps that tier back to CLIENT_DEFAULT_PERMS
    // anyway. Fails CLOSED: an unreadable count is treated as "already populated".
    const freshTiers = new Set<string>();
    for (const tier of ['Member', 'Dispatcher']) {
        const rId = roleMap[tier];
        if (!rId) continue;
        const { count, error } = await supabase.from('role_permissions')
            .select('role_id', { count: 'exact', head: true }).eq('role_id', rId);
        if (error) { log.error('role permission freshness check failed; skipping tier', { tier, err: error }); continue; }
        if (count === 0) freshTiers.add(tier);
        else log.info('tier already holds permissions; leaving its grants alone', { tier, count });
    }

    assign('Client', clientPerms);
    if (freshTiers.has('Member')) assign('Member', memberPerms);
    if (freshTiers.has('Dispatcher')) assign('Dispatcher', dispatcherPerms);
    assign('Admin', adminPerms);

    let seededBothTiers = false;
    if (rolePerms.length > 0) {
        // Upsert permissions (role_id, permission_id) is PK
        const { error: rpError } = await supabase.from('role_permissions').upsert(rolePerms, { ignoreDuplicates: true });
        if (rpError) log.error('role permissions seed failed', { err: rpError });
        else seededBothTiers = freshTiers.size === 2;
    }

    // A fresh install is BORN with the optional-module defaults, so the one-shot
    // repair backfill must never fire on it — otherwise the first Repair after an
    // operator revokes finance:view from Member hands it straight back, and Repair is
    // step 3 of every upgrade in DEPLOYMENT_GUIDE.md. Stamped only when BOTH tiers
    // actually took the full default set; a partial or skipped seed leaves the
    // backfill re-armable.
    if (seededBothTiers) await markOptionalModuleDefaultsApplied();

    // 4. Seed Default Rank & Unit
    // Check if exists first
    const { data: existingUnit } = await supabase.from('units').select('id').eq('name', 'Headquarters').maybeSingle();

    if (!existingUnit) {
        await supabase.from('units').insert({
            name: 'Headquarters',
            description: 'The Headquarters provides organisational command and control.',
            motto: 'Semper Vigilans'
        });
    }

    const ranksData = [
        { name: 'Recruit', sort_order: 0, icon_url: '/media/rank-1.png'},
        { name: 'Member', sort_order: 1, icon_url: '/media/rank-2.png'},
        { name: 'Officer', sort_order: 2, icon_url: '/media/rank-3.png'},
        { name: 'Command', sort_order: 3, icon_url: '/media/rank-4.png'}
    ];
    const { error: rError } = await supabase.from('ranks').upsert(ranksData, { onConflict: 'name', ignoreDuplicates: true });
    if (rError) log.error('ranks seed failed', { err: rError });

    // 5. Seed Settings
    const orgName = 'Operations';
    const defaultLogo = '/media/cross-swords.png';

    const defaultSettings = [
        { key: 'brandingConfig', value: {
            name: orgName,
            iconUrl: defaultLogo,
            dutyTimeoutMinutes: 30,
            bootSoundUrl: 'https://www.myinstants.com/media/sounds/death-stranding-build-open.mp3',
            newRequestSoundUrl: 'https://www.myinstants.com/media/sounds/police-radio-chirp.mp3',
            assignmentSoundUrl: 'https://www.myinstants.com/media/sounds/formula-1-radio-notification.mp3',
            eamSoundUrl: 'https://www.myinstants.com/media/sounds/google-pixel-emergency-sos-sound.mp3',
            radioMicCueUrl: 'https://www.myinstants.com/media/sounds/tick-deepfrozenapps-397275646-2.mp3',
            radioSquelchUrl: 'https://www.myinstants.com/media/sounds/rto.mp3'
        } },
        { key: 'discordConfig', value: { enabled: false } },
        { key: 'systemConfig', value: { appUrl: '', welcomeMessage: 'Welcome to the dashboard.' } }
    ];
    const { error: settingsError } = await supabase.from('settings').upsert(defaultSettings, { onConflict: 'key', ignoreDuplicates: true });
    if (settingsError) log.error('settings seed failed', { err: settingsError });

    // 6. Seed Specializations
    const specializationsData = [
        { name: 'Combat', description: 'Combat and tactical operations expertise.', icon: 'fa-solid fa-crosshairs'},
        { name: 'Medical', description: 'Medical and rescue operations expertise.', icon: 'fa-solid fa-user-doctor'},
        { name: 'Engineering', description: 'Engineering and technical expertise.', icon: 'fa-solid fa-wrench'},
        { name: 'Logistics', description: 'Cargo and logistics operations expertise.', icon: 'fa-solid fa-truck'},
        { name: 'Piloting', description: 'Advanced flight and navigation expertise.', icon: 'fa-solid fa-jet-fighter'}
    ];
    const { error: specError } = await supabase.from('specialization_tags').upsert(specializationsData, { onConflict: 'name', ignoreDuplicates: true });
    if (specError) log.error('specializations seed failed', { err: specError });

    // 7. Seed Certifications
    const certificationsData = [
        { name: 'Flight Certified', description: 'Certified for flight operations.', icon: 'fa-solid fa-plane'},
        { name: 'Combat Qualified', description: 'Qualified for combat operations.', icon: 'fa-solid fa-shield'},
        { name: 'Medical Technician', description: 'Certified medical responder.', icon: 'fa-solid fa-briefcase-medical'}
    ];
    const { error: certError } = await supabase.from('certifications').upsert(certificationsData, { onConflict: 'name', ignoreDuplicates: true });
    if (certError) log.error('certifications seed failed', { err: certError });

    // 8. Seed Commendations
    const commendationsData = [
        { name: 'Star of Valor', description: 'Awarded for exceptional bravery in the line of duty.', icon: 'fa-solid fa-star'},
        { name: 'Distinguished Service', description: 'Awarded for outstanding service and dedication.', icon: 'fa-solid fa-medal'},
        { name: 'Lifesaver Award', description: 'Awarded for saving lives in critical situations.', icon: 'fa-solid fa-heart-pulse'}
    ];
    const { error: commError } = await supabase.from('commendations').upsert(commendationsData, { onConflict: 'name', ignoreDuplicates: true });
    if (commError) log.error('commendations seed failed', { err: commError });

    // 9. Seed Default Radio Channel
    const { data: existingChannel } = await supabase.from('radio_channels')
        .select('id').eq('id', 'dispatch').maybeSingle();
    if (!existingChannel) {
        const { error: rcError } = await supabase.from('radio_channels').insert({
            id: 'dispatch',
            name: 'Dispatch',
            color: '#38bdf8',
            type: 'voice',
            sort_order: 0
        });
        if (rcError) log.error('default radio channel seed failed', { err: rcError });
    }

    // 10. Seed Locations
    await seedDefaultLocations();

    // 11. Seed Marketplace categories (reference taxonomy; seeded here — not in
    // schema.sql — so a full-reset reseed restores them).
    await seedMarketplaceCategories();

    // Bust any cached system-role lookup that may have been written by a parallel
    // request that ran while seeding was mid-flight. Without this, getSystemRoles
    // can serve a stale "no roles found" entry for the full 5-minute TTL even
    // after seeding finishes successfully.
    cache.invalidate('system_roles');

    log.info('install seeding complete', { roles: Object.keys(roleMap) });
    return { success: true, roles: roleMap };
}

/** Seed the marketplace category taxonomy (top-level + children, idempotent by
 *  slug). Two-pass so children can resolve their parent_id. */
export async function seedMarketplaceCategories() {
    const tops = [
        { slug: 'ships-vehicles', name: 'Ships & Vehicles', listing_kind: 'item', icon: 'fa-solid fa-rocket', sort_order: 0 },
        { slug: 'components', name: 'Ship Components', listing_kind: 'item', icon: 'fa-solid fa-microchip', sort_order: 1 },
        { slug: 'weapons-armor', name: 'Weapons & Armor', listing_kind: 'item', icon: 'fa-solid fa-gun', sort_order: 2 },
        { slug: 'cargo-commodities', name: 'Cargo & Commodities', listing_kind: 'item', icon: 'fa-solid fa-boxes-stacked', sort_order: 3 },
        { slug: 'consumables', name: 'Consumables & Gear', listing_kind: 'item', icon: 'fa-solid fa-kit-medical', sort_order: 4 },
        { slug: 'services', name: 'Services', listing_kind: 'service', icon: 'fa-solid fa-handshake-angle', sort_order: 5 },
        { slug: 'other', name: 'Other', listing_kind: 'both', icon: 'fa-solid fa-ellipsis', sort_order: 6 },
    ];
    const { error: topErr } = await supabase.from('marketplace_categories').upsert(tops, { onConflict: 'slug', ignoreDuplicates: true });
    if (topErr) { log.error('marketplace categories (top) seed failed', { err: topErr }); return; }

    const { data: parents } = await supabase.from('marketplace_categories').select('id, slug').is('parent_id', null);
    const bySlug = new Map(((parents as { id: number; slug: string }[]) || []).map((p) => [p.slug, p.id]));
    const c = (parentSlug: string, slug: string, name: string, kind: string, icon: string, sort: number) => ({
        slug, name, listing_kind: kind, icon, sort_order: sort, parent_id: bySlug.get(parentSlug),
    });
    const children = [
        c('services', 'svc-hauling', 'Hauling & Logistics', 'service', 'fa-solid fa-truck', 0),
        c('services', 'svc-escort', 'Escort & Security', 'service', 'fa-solid fa-shield-halved', 1),
        c('services', 'svc-mining', 'Mining', 'service', 'fa-solid fa-gem', 2),
        c('services', 'svc-salvage', 'Salvage', 'service', 'fa-solid fa-recycle', 3),
        c('services', 'svc-medical', 'Medical & Rescue', 'service', 'fa-solid fa-truck-medical', 4),
        c('services', 'svc-refuel-repair', 'Refuel & Repair', 'service', 'fa-solid fa-gas-pump', 5),
        c('components', 'cmp-power', 'Power Plants', 'item', 'fa-solid fa-bolt', 0),
        c('components', 'cmp-shields', 'Shield Generators', 'item', 'fa-solid fa-shield', 1),
        c('components', 'cmp-coolers', 'Coolers', 'item', 'fa-solid fa-snowflake', 2),
        c('components', 'cmp-qd', 'Quantum Drives', 'item', 'fa-solid fa-gauge-high', 3),
        c('weapons-armor', 'wa-ship-weapons', 'Ship Weapons', 'item', 'fa-solid fa-crosshairs', 0),
        c('weapons-armor', 'wa-fps', 'FPS Weapons', 'item', 'fa-solid fa-gun', 1),
        c('weapons-armor', 'wa-armor', 'Armor Sets', 'item', 'fa-solid fa-user-shield', 2),
        c('cargo-commodities', 'cc-raw', 'Raw Materials', 'item', 'fa-solid fa-mountain', 0),
        c('cargo-commodities', 'cc-refined', 'Refined Goods', 'item', 'fa-solid fa-industry', 1),
    ].filter((ch) => ch.parent_id != null);
    if (children.length > 0) {
        const { error: childErr } = await supabase.from('marketplace_categories').upsert(children, { onConflict: 'slug', ignoreDuplicates: true });
        if (childErr) log.error('marketplace categories (children) seed failed', { err: childErr });
    }
}

export async function resetOrgDefaults() {
    // Re-run full seed for structural data (roles, permissions, etc.) - safe with ignoreDuplicates
    await seedInstall();

    // Force-reset branding defaults (sounds, duty timeout, etc.)
    const orgName = 'Operations';
    const defaultLogo = '/media/cross-swords.png';

    const brandingDefaults = {
        name: orgName,
        iconUrl: defaultLogo,
        dutyTimeoutMinutes: 30,
        bootSoundUrl: 'https://www.myinstants.com/media/sounds/death-stranding-build-open.mp3',
        newRequestSoundUrl: 'https://www.myinstants.com/media/sounds/police-radio-chirp.mp3',
        assignmentSoundUrl: 'https://www.myinstants.com/media/sounds/formula-1-radio-notification.mp3',
        eamSoundUrl: 'https://www.myinstants.com/media/sounds/google-pixel-emergency-sos-sound.mp3',
        radioMicCueUrl: 'https://www.myinstants.com/media/sounds/tick-deepfrozenapps-397275646-2.mp3',
        radioSquelchUrl: 'https://www.myinstants.com/media/sounds/rto.mp3'
    };

    const { error } = await supabase.from('settings').upsert(
        { key: 'brandingConfig', value: brandingDefaults },
        { onConflict: 'key' }
    );
    if (error) log.error('branding defaults reset failed', { err: error });

    return { success: true };
}

export async function seedDefaultLocations() {
    const locationData: { localId: number; name: string; type: string; parentLocalId: number | null }[] = [
        { localId: 1, name: 'Stanton', type: 'System', parentLocalId: null },
        { localId: 18, name: 'Pyro', type: 'System', parentLocalId: null },
        { localId: 31, name: 'Nyx', type: 'System', parentLocalId: null },
        { localId: 2, name: 'Hurston', type: 'Planet', parentLocalId: 1 },
        { localId: 3, name: 'Crusader', type: 'Planet', parentLocalId: 1 },
        { localId: 4, name: 'ArcCorp', type: 'Planet', parentLocalId: 1 },
        { localId: 5, name: 'Microtech', type: 'Planet', parentLocalId: 1 },
        { localId: 19, name: 'Pyro I', type: 'Planet', parentLocalId: 18 },
        { localId: 20, name: 'Monox (Pyro II)', type: 'Planet', parentLocalId: 18 },
        { localId: 21, name: 'Bloom (Pyro III)', type: 'Planet', parentLocalId: 18 },
        { localId: 22, name: 'Pyro IV', type: 'Planet', parentLocalId: 18 },
        { localId: 23, name: 'Pyro V', type: 'Planet', parentLocalId: 18 },
        { localId: 24, name: 'Terminus (Pyro VI)', type: 'Planet', parentLocalId: 18 },
        { localId: 6, name: 'Arial', type: 'Moon', parentLocalId: 2 },
        { localId: 7, name: 'Aberdeen', type: 'Moon', parentLocalId: 2 },
        { localId: 8, name: 'Magda', type: 'Moon', parentLocalId: 2 },
        { localId: 9, name: 'Ita', type: 'Moon', parentLocalId: 2 },
        { localId: 10, name: 'Cellin', type: 'Moon', parentLocalId: 3 },
        { localId: 11, name: 'Daymar', type: 'Moon', parentLocalId: 3 },
        { localId: 12, name: 'Yela', type: 'Moon', parentLocalId: 3 },
        { localId: 13, name: 'Lyria', type: 'Moon', parentLocalId: 4 },
        { localId: 14, name: 'Wala', type: 'Moon', parentLocalId: 4 },
        { localId: 15, name: 'Calliope', type: 'Moon', parentLocalId: 5 },
        { localId: 16, name: 'Clio', type: 'Moon', parentLocalId: 5 },
        { localId: 17, name: 'Euterpe', type: 'Moon', parentLocalId: 5 },
        { localId: 25, name: 'Adir', type: 'Moon', parentLocalId: 23 },
        { localId: 26, name: 'Fairo', type: 'Moon', parentLocalId: 23 },
        { localId: 27, name: 'Fuego', type: 'Moon', parentLocalId: 23 },
        { localId: 28, name: 'Ignis', type: 'Moon', parentLocalId: 23 },
        { localId: 29, name: 'Vatra', type: 'Moon', parentLocalId: 23 },
        { localId: 30, name: 'Vuur', type: 'Moon', parentLocalId: 23 },
        { localId: 32, name: 'The Icebreaker', type: 'Facility', parentLocalId: 17 },
        { localId: 33, name: "Bud's Growery", type: 'Facility', parentLocalId: 17 },
        { localId: 34, name: 'Devlin Scrap & Salvage', type: 'Facility', parentLocalId: 17 },
        { localId: 35, name: 'Rayari Cantwell Research Outpost', type: 'Facility', parentLocalId: 16 },
        { localId: 36, name: 'Rayari McGrath Research Outpost', type: 'Facility', parentLocalId: 16 },
        { localId: 37, name: 'Shubin Mining Facility SMCa-6', type: 'Facility', parentLocalId: 15 },
        { localId: 38, name: 'Shubin Mining Facility SMCa-8', type: 'Facility', parentLocalId: 15 },
        { localId: 39, name: 'Shubin Processing Facility SPMC-1', type: 'Facility', parentLocalId: 15 },
        { localId: 40, name: 'Shubin Processing Facility SPMC-3', type: 'Facility', parentLocalId: 15 },
        { localId: 41, name: 'Shubin Processing Facility SPMC-5', type: 'Facility', parentLocalId: 15 },
        { localId: 42, name: 'Shubin Processing Facility SPMC-10', type: 'Facility', parentLocalId: 15 },
        { localId: 43, name: 'Shubin Processing Facility SPMC-11', type: 'Facility', parentLocalId: 15 },
        { localId: 44, name: 'Shubin Processing Facility SPMC-14', type: 'Facility', parentLocalId: 15 },
        { localId: 45, name: 'Rayari Anvik Research Outpost', type: 'Facility', parentLocalId: 15 },
        { localId: 46, name: 'Rayari Kaltag Research Outpost', type: 'Facility', parentLocalId: 15 },
        { localId: 47, name: "Raven's Roost", type: 'Facility', parentLocalId: 15 },
        { localId: 48, name: 'New Babbage', type: 'Facility', parentLocalId: 5 },
        { localId: 49, name: 'MT DataCenter 2UB-RB9-5', type: 'Facility', parentLocalId: 5 },
        { localId: 50, name: 'MT DataCenter 4HJ-LVE-A', type: 'Facility', parentLocalId: 5 },
        { localId: 51, name: 'MT DataCenter 5WQ-R2V-C', type: 'Facility', parentLocalId: 5 },
        { localId: 52, name: 'MT DataCenter 8FK-Q2X-K', type: 'Facility', parentLocalId: 5 },
        { localId: 53, name: 'MT DataCenter D79-ECG-R', type: 'Facility', parentLocalId: 5 },
        { localId: 54, name: 'MT DataCenter E2Q-NSG-Y', type: 'Facility', parentLocalId: 5 },
        { localId: 55, name: 'MT DataCenter TMG-XEV-2', type: 'Facility', parentLocalId: 5 },
        { localId: 56, name: 'MT DataCenter QVX-J88-J', type: 'Facility', parentLocalId: 5 },
        { localId: 57, name: 'Calhoun Pass Emergency Shelter', type: 'Facility', parentLocalId: 5 },
        { localId: 58, name: 'Point Wain Emergency Shelter', type: 'Facility', parentLocalId: 5 },
        { localId: 59, name: 'Nuiqsut Emergency Shelter', type: 'Facility', parentLocalId: 5 },
        { localId: 60, name: 'Clear View Emergency Shelter', type: 'Facility', parentLocalId: 5 },
        { localId: 61, name: 'Shubin Mining Facility SM0-10', type: 'Facility', parentLocalId: 5 },
        { localId: 62, name: 'Shubin Mining Facility SM0-22', type: 'Facility', parentLocalId: 5 },
        { localId: 63, name: 'Shubin Mining Facility SM0-18', type: 'Facility', parentLocalId: 5 },
        { localId: 64, name: 'Shubin Mining Facility SM0-13', type: 'Facility', parentLocalId: 5 },
        { localId: 65, name: 'MT OpCenter TLI-4', type: 'Facility', parentLocalId: 5 },
        { localId: 66, name: 'Rayari Deltana Research Outpost', type: 'Facility', parentLocalId: 5 },
        { localId: 67, name: 'Rayari Livengood Research Outpost', type: 'Facility', parentLocalId: 5 },
        { localId: 68, name: 'Ghost Hollow', type: 'Facility', parentLocalId: 5 },
        { localId: 69, name: 'Outpost 54', type: 'Facility', parentLocalId: 5 },
        { localId: 70, name: 'The Necropolis', type: 'Facility', parentLocalId: 5 },
        { localId: 71, name: 'HDMS-Hahn', type: 'Facility', parentLocalId: 8 },
        { localId: 72, name: 'HDMS-Perlman', type: 'Facility', parentLocalId: 8 },
        { localId: 73, name: 'HDMS-Woodruff', type: 'Facility', parentLocalId: 9 },
        { localId: 74, name: 'HDMS-Ryder', type: 'Facility', parentLocalId: 9 },
        { localId: 75, name: 'The Shades', type: 'Facility', parentLocalId: 9 },
        { localId: 76, name: 'Thimblerig', type: 'Facility', parentLocalId: 9 },
        { localId: 77, name: 'HDMS-Bezdek', type: 'Facility', parentLocalId: 6 },
        { localId: 78, name: 'HDMS-Lathan', type: 'Facility', parentLocalId: 6 },
        { localId: 79, name: 'HDMS-Norgaard', type: 'Facility', parentLocalId: 7 },
        { localId: 80, name: 'HDMS-Anderson', type: 'Facility', parentLocalId: 7 },
        { localId: 81, name: 'Klescher Rehabilitation Facility', type: 'Facility', parentLocalId: 7 },
        { localId: 82, name: 'Barton Flats Aid Shelter', type: 'Facility', parentLocalId: 7 },
        { localId: 83, name: 'HDMO-Dobbs', type: 'Facility', parentLocalId: 7 },
        { localId: 84, name: 'Ruptura PAF-I', type: 'Facility', parentLocalId: 7 },
        { localId: 85, name: 'Ruptura PAF-II', type: 'Facility', parentLocalId: 7 },
        { localId: 86, name: 'Ruptura PAF-III', type: 'Facility', parentLocalId: 7 },
        { localId: 87, name: 'Ruptura OLP', type: 'Facility', parentLocalId: 7 },
        { localId: 88, name: 'Vivere PAF-I', type: 'Facility', parentLocalId: 7 },
        { localId: 89, name: 'Vivere PAF-II', type: 'Facility', parentLocalId: 7 },
        { localId: 90, name: 'Vivere PAF-III', type: 'Facility', parentLocalId: 7 },
        { localId: 91, name: 'Vivere OLP', type: 'Facility', parentLocalId: 7 },
        { localId: 92, name: 'Lorville', type: 'Facility', parentLocalId: 2 },
        { localId: 93, name: 'HDMS-Edmond', type: 'Facility', parentLocalId: 2 },
        { localId: 94, name: 'HDMS-Hadley', type: 'Facility', parentLocalId: 2 },
        { localId: 95, name: 'HDMS-Oparei', type: 'Facility', parentLocalId: 2 },
        { localId: 96, name: 'HDMS-Pinewood', type: 'Facility', parentLocalId: 2 },
        { localId: 97, name: 'HDMS-Stanhope', type: 'Facility', parentLocalId: 2 },
        { localId: 98, name: 'HDMS-Thedus', type: 'Facility', parentLocalId: 2 },
        { localId: 99, name: 'HDSF-Adlai', type: 'Facility', parentLocalId: 2 },
        { localId: 100, name: 'HDSF-Barnabas', type: 'Facility', parentLocalId: 2 },
    ];

    const localIdToDbId: Record<number, number> = {};
    const typeOrder = ['System', 'Planet', 'Moon', 'Facility'];

    for (const type of typeOrder) {
        const batch = locationData.filter(l => l.type === type);
        for (const loc of batch) {
            const parentId = loc.parentLocalId ? localIdToDbId[loc.parentLocalId] || null : null;
            // Check if location already exists for this org before inserting
            const { data: existing } = await supabase.from('locations')
                .select('id').eq('name', loc.name).maybeSingle();
            if (existing) {
                localIdToDbId[loc.localId] = existing.id;
                continue;
            }
            const { data: inserted, error: locErr } = await supabase.from('locations')
                .insert({ name: loc.name, type: loc.type, parent_id: parentId})
                .select('id')
                .single();
            if (locErr) {
                log.error('location insert failed', { location: loc.name, message: locErr.message });
            } else if (inserted) {
                localIdToDbId[loc.localId] = inserted.id;
            }
        }
    }

    const count = Object.keys(localIdToDbId).length;
    log.info('seeded locations', { count });
    return { success: true, count };
}

/** @deprecated single-org rename of seedNewOrganization → seedInstall. Kept as a
 *  thin alias so existing callers (lib/db/system.ts repair path) keep compiling.
 *  Remove once all references are migrated. */
export const seedNewOrganization = seedInstall;
