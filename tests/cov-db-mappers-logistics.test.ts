import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    toPlatformShip, toUserShip, toFleetGroup, toTreasuryAccount, toLedgerEntry,
    toQmCatalogItem, toQmPlatformItem, toQmPlatformCategory, toWarehousePlatformCommodity,
    toWarehousePlatformCategory, toPlatformLocation, toQmLocation, toQmInventoryItem, toQmIssuance,
    toAcademyUserRef, toAcademyLesson, toAcademyModule, toAcademyOutcome, toAcademyCourse,
    toAcademySession, toAcademyLessonProgress, toAcademyOutcomeResult, toAcademyEnrollment,
    toBlueprint, toCraftableItem, toBlueprintRequest,
} from '../lib/db/mappers';
import { ROSTER_SAFE_FIELDS } from '../lib/db/userFilters';
import { ShipStatus, FleetGroupType } from '../types';

// lib/db/mappers.ts — fleet, finances, quartermaster, warehouse, locations, academy
// and blueprint mappers. Exact-shape assertions: unmapped input columns (`*_LEAK`)
// must never reach the output, and the null/default fallbacks are pinned per field
// (several deliberately distinguish "unknown" (null) from "false"/"0").

const NOW = '2026-03-04T05:06:07.000Z';
const DEFAULT_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';
const MINI_KEYS = [...new Set([...ROSTER_SAFE_FIELDS, 'discordId', 'permissions', 'conductRecord', 'limitingMarkers'])].sort();

function secretUserRow(id: number, name: string): Record<string, unknown> {
    return {
        id, name, discord_id: '990000000000000001', avatar_url: `${name}.png`,
        admin_notes: 'SECRET-admin', personnel_notes: 'SECRET-personnel', rsi_verification_code: 'SECRET-code',
        limiting_markers: [{ marker: 'SECRET-m' }],
    };
}

function expectMiniUser(u: unknown, id: number, name: string) {
    expect(u).toBeDefined();
    const rec = u as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(MINI_KEYS);
    expect(rec.id).toBe(id);
    expect(rec.name).toBe(name);
    expect(rec.discordId).toBe('');
    expect(JSON.stringify(rec)).not.toContain('SECRET');
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

describe('fleet mappers', () => {
    const SHIP_SPARSE_OUT = {
        id: 2, externalUuid: undefined, externalApiId: undefined, name: 'Pisces', manufacturer: 'Anvil',
        manufacturerCode: undefined, role: undefined, career: undefined, size: undefined, crewMin: 1, crewMax: 1,
        cargoCapacity: 0, length: undefined, beam: undefined, height: undefined, mass: undefined, scmSpeed: undefined,
        maxSpeed: undefined, health: undefined, shieldHp: undefined, imageUrl: undefined, wikiUrl: undefined,
        pledgeUrl: undefined, msrp: undefined, description: undefined, productionStatus: undefined,
    };

    it('toPlatformShip maps a full row, parsing numeric-string dimensions', () => {
        expect(toPlatformShip({
            id: 1, external_uuid: 'uuid', external_api_id: 'api', name: 'Hammerhead', manufacturer: 'Aegis',
            manufacturer_code: 'AEGS', role: 'Gunship', career: 'Combat', size: 'Large', crew_min: 4, crew_max: 9,
            cargo_capacity: 40, length: '115.5', beam: 60, height: '20.25', mass: 1000, scm_speed: 150, max_speed: 1000,
            health: 50000, shield_hp: 30000, image_url: 'hh.png', wiki_url: 'w', pledge_url: 'p', msrp: '725.00',
            description: 'd', production_status: 'flight-ready', created_at: 'LEAK', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 1, externalUuid: 'uuid', externalApiId: 'api', name: 'Hammerhead', manufacturer: 'Aegis',
            manufacturerCode: 'AEGS', role: 'Gunship', career: 'Combat', size: 'Large', crewMin: 4, crewMax: 9,
            cargoCapacity: 40, length: 115.5, beam: 60, height: 20.25, mass: 1000, scmSpeed: 150, maxSpeed: 1000,
            health: 50000, shieldHp: 30000, imageUrl: 'hh.png', wikiUrl: 'w', pledgeUrl: 'p', msrp: 725,
            description: 'd', productionStatus: 'flight-ready',
        });
    });

    it('toPlatformShip defaults a sparse row', () => {
        expect(toPlatformShip({
            id: 2, name: 'Pisces', manufacturer: 'Anvil', external_uuid: null, crew_min: null, crew_max: 0,
            cargo_capacity: null, length: null, beam: 0, height: '', msrp: null,
        } as never)).toStrictEqual(SHIP_SPARSE_OUT);
    });

    it('toUserShip maps a full row: owner minified, platform ship mapped, assignment id carried', () => {
        const s = toUserShip({
            id: 7, user_id: 11, user: secretUserRow(11, 'Owner'), ship_id: 2,
            ship: { id: 2, name: 'Pisces', manufacturer: 'Anvil' }, custom_name: 'Lil Fish', loadout_notes: 'stock',
            status: 'Stored', is_primary: true, created_at: 'c', __assignment_id: 33, secret_LEAK: 1,
        } as never);
        expectMiniUser(s.user, 11, 'Owner');
        expect(s).toStrictEqual({
            id: 7, userId: 11, user: s.user, shipId: 2, ship: SHIP_SPARSE_OUT, customName: 'Lil Fish',
            loadoutNotes: 'stock', status: ShipStatus.Stored, isPrimary: true, createdAt: 'c', assignmentId: 33,
        });
    });

    it('toUserShip defaults a sparse row to an Active, non-primary ship', () => {
        expect(toUserShip({ id: 8, user_id: 11, ship_id: 2, custom_name: null, loadout_notes: null, status: null, is_primary: null, created_at: 'c' } as never))
            .toStrictEqual({
                id: 8, userId: 11, user: undefined, shipId: 2, ship: undefined, customName: undefined, loadoutNotes: undefined,
                status: ShipStatus.Active, isPrimary: false, createdAt: 'c', assignmentId: undefined,
            });
    });

    it('toFleetGroup maps a full row (commander minified) and defaults a sparse one', () => {
        const g = toFleetGroup({
            id: 1, name: '1st Wing', type: 'Wing', parent_id: 9, commander_id: 11, commander: secretUserRow(11, 'CO'),
            description: 'd', icon: 'i', sort_order: 3, created_at: 'LEAK',
        } as never);
        expectMiniUser(g.commander, 11, 'CO');
        expect(g).toStrictEqual({
            id: 1, name: '1st Wing', type: FleetGroupType.Wing, parentId: 9, commanderId: 11, commander: g.commander,
            description: 'd', icon: 'i', sortOrder: 3, children: [], assignedShips: [],
        });
        expect(toFleetGroup({ id: 2, name: 'G', type: null, parent_id: null, commander_id: null, description: null, icon: null, sort_order: null } as never))
            .toStrictEqual({
                id: 2, name: 'G', type: FleetGroupType.Custom, parentId: undefined, commanderId: undefined, commander: undefined,
                description: undefined, icon: undefined, sortOrder: 0, children: [], assignedShips: [],
            });
    });
});

describe('finance mappers', () => {
    it('toTreasuryAccount maps a full row and coerces the cached balance', () => {
        expect(toTreasuryAccount({
            id: 'acc', name: 'Ops', type: 'operations', description: 'd', balance_cached: '1500.5', is_active: true,
            created_at: 'c', updated_at: 'u', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 'acc', name: 'Ops', type: 'operations', description: 'd', balanceCached: 1500.5, isActive: true, createdAt: 'c', updatedAt: 'u',
        });
        expect(toTreasuryAccount({ id: 'a2', name: 'N', type: null, description: null, balance_cached: null, is_active: null, created_at: 'c', updated_at: 'u' } as never))
            .toStrictEqual({ id: 'a2', name: 'N', type: 'general', description: null, balanceCached: 0, isActive: true, createdAt: 'c', updatedAt: 'u' });
        // Only an explicit false deactivates.
        expect(toTreasuryAccount({ id: 'a3', name: 'N', is_active: false, created_at: 'c', updated_at: 'u' } as never).isActive).toBe(false);
        expect(toTreasuryAccount({ id: 'a4', name: 'N', description: undefined, created_at: 'c', updated_at: 'u' } as never).description).toBeNull();
    });

    it('toLedgerEntry maps a full row; counterparty embeds expose only the card fields', () => {
        expect(toLedgerEntry({
            id: 'e1', account_id: 'acc', entry_type: 'deposit', amount: '250', status: 'approved', memo: 'm',
            counterparty_user_id: 11, counterparty: { id: 11, name: 'Payer', avatar_url: 'p.png', rsi_handle: 'payer', discord_id: 'LEAK' },
            counterparty_text: 'cash', operation_id: 'op', related_inventory_id: 'inv', related_entry_id: 'e0',
            transfer_group_id: 'tg', created_by_user_id: 12, created_by: { id: 12, name: null, avatar_url: null, rsi_handle: null },
            approved_by_user_id: 13, approved_by: { id: 13, name: 'Treasurer', avatar_url: 't.png', rsi_handle: 'tr' },
            approved_at: 'aa', notes: 'n', created_at: 'c', updated_at: 'u', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 'e1', accountId: 'acc', entryType: 'deposit', amount: 250, status: 'approved', memo: 'm',
            counterpartyUserId: 11, counterparty: { id: 11, name: 'Payer', avatarUrl: 'p.png', rsiHandle: 'payer' },
            counterpartyText: 'cash', operationId: 'op', relatedInventoryId: 'inv', relatedEntryId: 'e0',
            transferGroupId: 'tg', createdByUserId: 12, createdBy: { id: 12, name: 'Unknown', avatarUrl: DEFAULT_AVATAR, rsiHandle: '' },
            approvedByUserId: 13, approvedBy: { id: 13, name: 'Treasurer', avatarUrl: 't.png', rsiHandle: 'tr' },
            approvedAt: 'aa', notes: 'n', createdAt: 'c', updatedAt: 'u',
        });
    });

    it('toLedgerEntry nulls every absent optional column', () => {
        expect(toLedgerEntry({
            id: 'e2', account_id: 'acc', entry_type: 'withdrawal', amount: 10, status: 'pending', created_by_user_id: 12,
            created_at: 'c', updated_at: 'u',
        } as never)).toStrictEqual({
            id: 'e2', accountId: 'acc', entryType: 'withdrawal', amount: 10, status: 'pending', memo: null,
            counterpartyUserId: null, counterparty: undefined, counterpartyText: null, operationId: null,
            relatedInventoryId: null, relatedEntryId: null, transferGroupId: null, createdByUserId: 12, createdBy: undefined,
            approvedByUserId: null, approvedBy: undefined, approvedAt: null, notes: null, createdAt: 'c', updatedAt: 'u',
        });
    });
});

describe('quartermaster catalog / location mappers', () => {
    it('toQmCatalogItem: full and defaulted', () => {
        expect(toQmCatalogItem({
            id: 'q1', slug: 'p4-ar', name: 'P4-AR', category: 'weapon', subcategory: 'rifle', attributes: { size: 1 },
            source: 'platform', thumbnail_url: 't.png', wiki_url: 'w', created_at: 'c', updated_at: 'u', external_uuid: 'LEAK',
        } as never)).toStrictEqual({
            id: 'q1', slug: 'p4-ar', name: 'P4-AR', category: 'weapon', subcategory: 'rifle', attributes: { size: 1 },
            source: 'platform', thumbnailUrl: 't.png', wikiUrl: 'w', createdAt: 'c', updatedAt: 'u',
        });
        expect(toQmCatalogItem({ id: 'q2', slug: 's', name: 'N', category: 'misc', created_at: 'c', updated_at: 'u', attributes: null, source: null } as never))
            .toStrictEqual({ id: 'q2', slug: 's', name: 'N', category: 'misc', subcategory: null, attributes: {}, source: 'custom', thumbnailUrl: null, wikiUrl: null, createdAt: 'c', updatedAt: 'u' });
    });

    it('toQmPlatformItem: full row (source forced to platform) and defaulted row', () => {
        const full = {
            id: 'p1', slug: 's', name: 'N', category: 'armor', subcategory: 'helmet', attributes: { a: 1 }, source: 'custom',
            thumbnail_url: 't', wiki_url: 'w', external_uuid: 'eu', external_id: 9, is_vehicle_item: 1, is_commodity: true,
            is_harvestable: true, screenshot_url: 'sc', store_url: 'st', company_name: 'co', vehicle_name: 'vn', quality: 3,
            size_label: 'L', color: 'red', color2: 'blue', game_version: '4.0', platform_category_id: 7, last_synced_at: 'ls',
            created_at: 'c', updated_at: 'u', secret_LEAK: 1,
        };
        expect(toQmPlatformItem(full as never)).toStrictEqual({
            id: 'p1', slug: 's', name: 'N', category: 'armor', subcategory: 'helmet', attributes: { a: 1 }, source: 'platform',
            thumbnailUrl: 't', wikiUrl: 'w', externalUuid: 'eu', externalId: 9, isVehicleItem: true, isCommodity: true,
            isHarvestable: true, screenshotUrl: 'sc', storeUrl: 'st', companyName: 'co', vehicleName: 'vn', quality: 3,
            sizeLabel: 'L', color: 'red', color2: 'blue', gameVersion: '4.0', platformCategoryId: 7, lastSyncedAt: 'ls',
            createdAt: 'c', updatedAt: 'u',
        });
        expect(toQmPlatformItem({ id: 'p2', slug: 's', name: 'N', category: 'misc', created_at: 'c', updated_at: 'u', attributes: null, quality: '3' } as never))
            .toStrictEqual({
                id: 'p2', slug: 's', name: 'N', category: 'misc', subcategory: null, attributes: {}, source: 'platform',
                thumbnailUrl: null, wikiUrl: null, externalUuid: null, externalId: null, isVehicleItem: false, isCommodity: false,
                isHarvestable: false, screenshotUrl: null, storeUrl: null, companyName: null, vehicleName: null,
                // A non-numeric quality is unknown, not coerced.
                quality: null, sizeLabel: null, color: null, color2: null, gameVersion: null, platformCategoryId: null,
                lastSyncedAt: null, createdAt: 'c', updatedAt: 'u',
            });
    });

    it('toQmPlatformCategory / toWarehousePlatformCategory: full and defaulted', () => {
        expect(toQmPlatformCategory({
            id: 1, uex_category_id: 10, uex_category_name: 'Armor', uex_section: 'Personal', display_name: 'Armour',
            sort_order: 2, is_hidden: true, created_at: 'c', updated_at: 'u', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 1, uexCategoryId: 10, uexCategoryName: 'Armor', uexSection: 'Personal', displayName: 'Armour', sortOrder: 2, isHidden: true, createdAt: 'c', updatedAt: 'u',
        });
        expect(toQmPlatformCategory({ id: 2, uex_category_id: 11, uex_category_name: 'X', display_name: 'X', sort_order: null, is_hidden: null, created_at: 'c', updated_at: 'u' } as never))
            .toStrictEqual({ id: 2, uexCategoryId: 11, uexCategoryName: 'X', uexSection: null, displayName: 'X', sortOrder: 0, isHidden: false, createdAt: 'c', updatedAt: 'u' });
        expect(toWarehousePlatformCategory({
            id: 1, slug: 'metals', uex_kind: 'Metal', display_name: 'Metals', sort_order: 4, is_hidden: true, created_at: 'c', updated_at: 'u', secret_LEAK: 1,
        } as never)).toStrictEqual({ id: 1, slug: 'metals', uexKind: 'Metal', displayName: 'Metals', sortOrder: 4, isHidden: true, createdAt: 'c', updatedAt: 'u' });
        expect(toWarehousePlatformCategory({ id: 2, slug: 's', uex_kind: 'K', display_name: 'D', sort_order: null, is_hidden: null, created_at: 'c', updated_at: 'u' } as never))
            .toStrictEqual({ id: 2, slug: 's', uexKind: 'K', displayName: 'D', sortOrder: 0, isHidden: false, createdAt: 'c', updatedAt: 'u' });
    });

    it('toWarehousePlatformCommodity keeps tri-state flags and coerces numeric strings', () => {
        const flagCols = ['is_available', 'is_available_live', 'is_visible', 'is_extractable', 'is_mineral', 'is_raw', 'is_pure',
            'is_refined', 'is_refinable', 'is_harvestable', 'is_buyable', 'is_sellable', 'is_temporary', 'is_illegal',
            'is_volatile_qt', 'is_volatile_time', 'is_inert', 'is_explosive', 'is_buggy', 'is_fuel'];
        const flagKeys = ['isAvailable', 'isAvailableLive', 'isVisible', 'isExtractable', 'isMineral', 'isRaw', 'isPure',
            'isRefined', 'isRefinable', 'isHarvestable', 'isBuyable', 'isSellable', 'isTemporary', 'isIllegal',
            'isVolatileQt', 'isVolatileTime', 'isInert', 'isExplosive', 'isBuggy', 'isFuel'];
        const base = { id: 1, external_id: 5, slug: 'gold', name: 'Gold', created_at: 'c', updated_at: 'u' };

        const truthy = toWarehousePlatformCommodity({
            ...base, external_uuid: 'eu', code: 'GOLD', kind: 'Metal', weight_scu: 1, price_buy: '12.5', price_sell: 15,
            ...Object.fromEntries(flagCols.map((c, i) => [c, i % 2 === 0 ? 1 : true])),
            wiki_url: 'w', platform_category_id: 3, uex_date_added: 100, uex_date_modified: 200, last_synced_at: 'ls', secret_LEAK: 1,
        } as never);
        expect(truthy).toStrictEqual({
            id: 1, externalId: 5, externalUuid: 'eu', slug: 'gold', name: 'Gold', code: 'GOLD', kind: 'Metal',
            weightScu: 1, priceBuy: 12.5, priceSell: 15,
            ...Object.fromEntries(flagKeys.map(k => [k, true])),
            wikiUrl: 'w', platformCategoryId: 3, uexDateAdded: 100, uexDateModified: 200, lastSyncedAt: 'ls', createdAt: 'c', updatedAt: 'u',
        });

        const falsy = toWarehousePlatformCommodity({ ...base, ...Object.fromEntries(flagCols.map(c => [c, false])), weight_scu: 0 } as never);
        for (const k of flagKeys) expect((falsy as unknown as Record<string, unknown>)[k], k).toBe(false);
        expect(falsy.weightScu).toBe(0);

        // null / missing → null ("unknown"), never false; non-numeric dates → null.
        expect(toWarehousePlatformCommodity({
            ...base, weight_scu: null, price_buy: undefined, uex_date_added: '100', uex_date_modified: null,
            ...Object.fromEntries(flagCols.map((c, i) => [c, i % 2 === 0 ? null : undefined])),
        } as never)).toStrictEqual({
            id: 1, externalId: 5, externalUuid: null, slug: 'gold', name: 'Gold', code: null, kind: null,
            weightScu: null, priceBuy: null, priceSell: null,
            ...Object.fromEntries(flagKeys.map(k => [k, null])),
            wikiUrl: null, platformCategoryId: null, uexDateAdded: null, uexDateModified: null, lastSyncedAt: null, createdAt: 'c', updatedAt: 'u',
        });
    });

    it('toPlatformLocation: full row, tri-state flags, amenities guard', () => {
        expect(toPlatformLocation({
            id: 1, kind: 'station', external_id: 9, parent_id: 2, star_system_id: 3, name: 'Port Olisar', nickname: 'PO',
            code: 'PO', path: 'Stanton/Crusader', is_available_live: 1, is_visible: true, is_landable: true, is_armistice: true,
            is_decommissioned: true, is_internal: 1, is_hidden: true, pad_types: ['S', 'M'], amenities: { refuel: true },
            faction_name: 'UEE', jurisdiction_name: 'Crusader', wiki_url: 'w', uex_date_added: 1, uex_date_modified: 2,
            last_synced_at: 'ls', created_at: 'c', updated_at: 'u', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 1, kind: 'station', externalId: 9, parentId: 2, starSystemId: 3, name: 'Port Olisar', nickname: 'PO',
            code: 'PO', path: 'Stanton/Crusader', isAvailableLive: true, isVisible: true, isLandable: true, isArmistice: true,
            isDecommissioned: true, isInternal: true, isHidden: true, padTypes: ['S', 'M'], amenities: { refuel: true },
            factionName: 'UEE', jurisdictionName: 'Crusader', wikiUrl: 'w', uexDateAdded: 1, uexDateModified: 2,
            lastSyncedAt: 'ls', createdAt: 'c', updatedAt: 'u',
        });
        expect(toPlatformLocation({
            id: 2, kind: 'planet', external_id: 1, name: 'Yela', is_available_live: null, is_visible: false,
            is_landable: undefined, is_armistice: null, is_decommissioned: false, is_internal: null, is_hidden: null,
            amenities: 'not-an-object', uex_date_added: '1', created_at: 'c', updated_at: 'u',
        } as never)).toStrictEqual({
            id: 2, kind: 'planet', externalId: 1, parentId: null, starSystemId: null, name: 'Yela', nickname: null,
            code: null, path: null, isAvailableLive: null, isVisible: false, isLandable: null, isArmistice: null,
            isDecommissioned: false, isInternal: false, isHidden: false, padTypes: null, amenities: {},
            factionName: null, jurisdictionName: null, wikiUrl: null, uexDateAdded: null, uexDateModified: null,
            lastSyncedAt: null, createdAt: 'c', updatedAt: 'u',
        });
        expect(toPlatformLocation({ id: 3, kind: 'city', external_id: 2, name: 'Lorville', amenities: null, created_at: 'c', updated_at: 'u' } as never).amenities)
            .toStrictEqual({});
    });

    it('toQmLocation: full and defaulted', () => {
        expect(toQmLocation({ id: 'l1', name: 'Hangar', type: 'hangar', parent_id: 'l0', description: 'd', sort_order: 3, created_at: 'c', updated_at: 'u', secret_LEAK: 1 } as never))
            .toStrictEqual({ id: 'l1', name: 'Hangar', type: 'hangar', parentId: 'l0', description: 'd', sortOrder: 3, createdAt: 'c', updatedAt: 'u' });
        expect(toQmLocation({ id: 'l2', name: 'N', type: null, sort_order: null, created_at: 'c', updated_at: 'u' } as never))
            .toStrictEqual({ id: 'l2', name: 'N', type: 'custom', parentId: null, description: null, sortOrder: 0, createdAt: 'c', updatedAt: 'u' });
    });
});

describe('quartermaster inventory / issuance mappers', () => {
    it('toQmInventoryItem maps a full row with narrowed catalog/location embeds', () => {
        expect(toQmInventoryItem({
            id: 'inv1', catalog_id: 'q1', custom_name: 'Rifle #1', location_id: 'l1', condition: 'worn', acquired_at: 'aq',
            notes: 'n', is_archived: true, quantity_on_hand: '3', quantity_on_issue: 1, created_at: 'c', updated_at: 'u',
            catalog: { id: 'q1', slug: 'p4', name: 'P4-AR', category: 'weapon', subcategory: 'rifle', thumbnail_url: 't', attributes: 'LEAK' },
            location: { id: 'l1', name: 'Hangar', type: 'hangar', description: 'LEAK' },
            secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 'inv1', catalogId: 'q1',
            catalog: { id: 'q1', slug: 'p4', name: 'P4-AR', category: 'weapon', subcategory: 'rifle', thumbnailUrl: 't' },
            customName: 'Rifle #1', locationId: 'l1', location: { id: 'l1', name: 'Hangar', type: 'hangar' },
            condition: 'worn', acquiredAt: 'aq', notes: 'n', isArchived: true, quantityOnHand: 3, quantityOnIssue: 1,
            createdAt: 'c', updatedAt: 'u',
        });
    });

    it('toQmInventoryItem defaults a sparse row (pristine, not archived, zero quantities)', () => {
        expect(toQmInventoryItem({
            id: 'inv2', acquired_at: 'aq', is_archived: 'yes', created_at: 'c', updated_at: 'u',
            catalog: { id: 'q1', slug: 's', name: 'N', category: 'misc', subcategory: null, thumbnail_url: null },
        } as never)).toStrictEqual({
            id: 'inv2', catalogId: null,
            catalog: { id: 'q1', slug: 's', name: 'N', category: 'misc', subcategory: null, thumbnailUrl: null },
            customName: null, locationId: null, location: undefined, condition: 'pristine', acquiredAt: 'aq', notes: null,
            // Only a literal true archives.
            isArchived: false, quantityOnHand: 0, quantityOnIssue: 0, createdAt: 'c', updatedAt: 'u',
        });
        // A custom (non-catalog) item has no catalog embed at all.
        const custom = toQmInventoryItem({ id: 'inv3', custom_name: 'Hand-made', catalog: null, location: null, acquired_at: 'aq', created_at: 'c', updated_at: 'u' } as never);
        expect(custom.catalog).toBeUndefined();
        expect(custom.location).toBeUndefined();
        expect(custom.customName).toBe('Hand-made');
    });

    it('toQmIssuance maps a full row; user refs expose card fields only', () => {
        expect(toQmIssuance({
            id: 'is1', inventory_id: 'inv1', issued_to_user_id: 11, quantity: 2, status: 'returned', requested_at: 'ra',
            issued_at: 'ia', due_back_at: '2020-01-01T00:00:00.000Z', returned_at: 'rt', returned_quantity: 2, outcome: 'returned',
            requested_by_user_id: 11, issued_by_user_id: 12, closed_by_user_id: 13, notes: 'n', operation_id: 'op',
            created_at: 'c', updated_at: 'u',
            inventory: { id: 'inv1', custom_name: 'Rifle', catalog: { name: 'P4-AR', category: 'weapon', slug: 'LEAK' } },
            issued_to: { id: 11, name: 'Holder', avatar_url: 'h.png', rsi_handle: 'holder', discord_id: 'LEAK' },
            requested_by: { id: 11, name: null, avatar_url: null, rsi_handle: null },
            issued_by: { id: 12, name: 'QM', avatar_url: 'q.png', rsi_handle: 'qm' },
            closed_by: { id: 13, name: 'QM2', avatar_url: 'q2.png', rsi_handle: 'qm2' },
            secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 'is1', inventoryId: 'inv1',
            inventory: { id: 'inv1', customName: 'Rifle', catalog: { name: 'P4-AR', category: 'weapon' } },
            issuedToUserId: 11, issuedTo: { id: 11, name: 'Holder', avatarUrl: 'h.png', rsiHandle: 'holder' },
            quantity: 2, status: 'returned', requestedAt: 'ra', issuedAt: 'ia', dueBackAt: '2020-01-01T00:00:00.000Z',
            returnedAt: 'rt', returnedQuantity: 2, outcome: 'returned',
            requestedByUserId: 11, requestedBy: { id: 11, name: 'Unknown', avatarUrl: DEFAULT_AVATAR, rsiHandle: '' },
            issuedByUserId: 12, issuedBy: { id: 12, name: 'QM', avatarUrl: 'q.png', rsiHandle: 'qm' },
            closedByUserId: 13, closedBy: { id: 13, name: 'QM2', avatarUrl: 'q2.png', rsiHandle: 'qm2' },
            notes: 'n', operationId: 'op',
            // Past due but not active → not overdue.
            isOverdue: false, createdAt: 'c', updatedAt: 'u',
        });
    });

    it('toQmIssuance isOverdue is true only for an ACTIVE issuance past its due date', () => {
        const base = { id: 'is2', inventory_id: 'inv1', issued_to_user_id: 11, quantity: 1, created_at: 'c', updated_at: 'u' };
        expect(toQmIssuance({ ...base, status: 'active', due_back_at: '2026-03-04T05:06:06.000Z' } as never).isOverdue).toBe(true);
        expect(toQmIssuance({ ...base, status: 'active', due_back_at: '2026-03-04T05:06:08.000Z' } as never).isOverdue).toBe(false);
        expect(toQmIssuance({ ...base, status: 'active', due_back_at: null } as never).isOverdue).toBe(false);
        expect(toQmIssuance({ ...base, status: 'requested', due_back_at: '2000-01-01T00:00:00.000Z' } as never).isOverdue).toBe(false);
    });

    it('toQmIssuance nulls every absent optional column and leaves embeds undefined', () => {
        expect(toQmIssuance({
            id: 'is3', inventory_id: 'inv1', issued_to_user_id: 11, quantity: 1, status: 'requested', created_at: 'c', updated_at: 'u',
            inventory: { id: 'inv1', custom_name: null, catalog: null },
        } as never)).toStrictEqual({
            id: 'is3', inventoryId: 'inv1', inventory: { id: 'inv1', customName: null, catalog: undefined },
            issuedToUserId: 11, issuedTo: undefined, quantity: 1, status: 'requested', requestedAt: null, issuedAt: null,
            dueBackAt: null, returnedAt: null, returnedQuantity: null, outcome: null, requestedByUserId: null,
            requestedBy: undefined, issuedByUserId: null, issuedBy: undefined, closedByUserId: null, closedBy: undefined,
            notes: null, operationId: null, isOverdue: false, createdAt: 'c', updatedAt: 'u',
        });
        expect(toQmIssuance({ id: 'is4', inventory_id: 'inv1', issued_to_user_id: 1, quantity: 1, status: 'requested', created_at: 'c', updated_at: 'u', inventory: null } as never).inventory)
            .toBeUndefined();
    });
});

describe('academy mappers', () => {
    it('toAcademyUserRef: full, null-column, and missing ref', () => {
        expect(toAcademyUserRef({ id: 1, name: 'Inst', avatar_url: 'a.png', rsi_handle: 'inst', discord_id: 'LEAK' } as never))
            .toStrictEqual({ id: 1, name: 'Inst', avatarUrl: 'a.png', rsiHandle: 'inst' });
        expect(toAcademyUserRef({ id: 2, name: null, avatar_url: null, rsi_handle: null }))
            .toStrictEqual({ id: 2, name: '', avatarUrl: '', rsiHandle: '' });
        expect(toAcademyUserRef(null)).toBeNull();
    });

    it('toAcademyLesson / toAcademyModule / toAcademyOutcome: full and defaulted', () => {
        expect(toAcademyLesson({ id: 'l', module_id: 'm', title: 'T', content: { a: 1 }, video_url: 'v', sort_order: 1, estimated_minutes: 15, secret_LEAK: 1 } as never))
            .toStrictEqual({ id: 'l', moduleId: 'm', title: 'T', content: { a: 1 }, videoUrl: 'v', sortOrder: 1, estimatedMinutes: 15 });
        expect(toAcademyLesson({ id: 'l2', module_id: 'm', title: 'T', sort_order: 0 } as never))
            .toStrictEqual({ id: 'l2', moduleId: 'm', title: 'T', content: null, videoUrl: null, sortOrder: 0, estimatedMinutes: null });
        expect(toAcademyModule({ id: 'm', course_id: 'c', title: 'M', description: 'd', sort_order: 2, secret_LEAK: 1 } as never))
            .toStrictEqual({ id: 'm', courseId: 'c', title: 'M', description: 'd', sortOrder: 2, lessons: [] });
        expect(toAcademyModule({ id: 'm2', course_id: 'c', title: 'M', sort_order: 0 } as never).description).toBeNull();
        expect(toAcademyOutcome({ id: 'o', course_id: 'c', title: 'O', description: 'd', sort_order: 1, required: false, secret_LEAK: 1 } as never))
            .toStrictEqual({ id: 'o', courseId: 'c', title: 'O', description: 'd', sortOrder: 1, required: false });
        // Only an explicit false makes an outcome optional.
        expect(toAcademyOutcome({ id: 'o2', course_id: 'c', title: 'O', sort_order: 1, required: null } as never))
            .toStrictEqual({ id: 'o2', courseId: 'c', title: 'O', description: null, sortOrder: 1, required: true });
    });

    it('toAcademyCourse: full and defaulted (cohort delivery, empty collections)', () => {
        expect(toAcademyCourse({
            id: 'c', title: 'Flight', description: 'd', icon: 'i', image_url: 'img', status: 'published', access: 'open',
            delivery: 'self_paced', certification_id: 4, created_by: 11, approved_by: 12, published_at: 'p', sort_order: 1,
            created_at: 'ca', updated_at: 'ua', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 'c', title: 'Flight', description: 'd', icon: 'i', imageUrl: 'img', status: 'published', access: 'open',
            delivery: 'self_paced', certificationId: 4, certification: null, createdBy: 11, approvedBy: 12, publishedAt: 'p',
            sortOrder: 1, createdAt: 'ca', updatedAt: 'ua', instructors: [], modules: [], outcomes: [],
        });
        expect(toAcademyCourse({ id: 'c2', title: 'T', status: 'draft', access: 'restricted', delivery: null, created_by: 1, sort_order: 0, created_at: 'ca', updated_at: 'ua' } as never))
            .toStrictEqual({
                id: 'c2', title: 'T', description: null, icon: null, imageUrl: null, status: 'draft', access: 'restricted',
                delivery: 'cohort', certificationId: null, certification: null, createdBy: 1, approvedBy: null, publishedAt: null,
                sortOrder: 0, createdAt: 'ca', updatedAt: 'ua', instructors: [], modules: [], outcomes: [],
            });
    });

    it('toAcademySession: full and defaulted (enrollment open, not implicit)', () => {
        expect(toAcademySession({
            id: 's', course_id: 'c', title: 'Cohort 1', status: 'scheduled', starts_at: 'st', ends_at: 'en', location: 'Hangar',
            capacity: 10, enrollment_open: false, is_implicit: true, created_by: 11, created_at: 'ca', updated_at: 'ua', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 's', courseId: 'c', courseTitle: null, title: 'Cohort 1', status: 'scheduled', startsAt: 'st', endsAt: 'en',
            location: 'Hangar', capacity: 10, enrollmentOpen: false, isImplicit: true, createdBy: 11, createdAt: 'ca',
            updatedAt: 'ua', instructors: [], enrollmentCount: 0,
        });
        expect(toAcademySession({ id: 's2', course_id: 'c', title: 'T', status: 'draft', enrollment_open: null, is_implicit: 'true', created_by: 1, created_at: 'ca', updated_at: 'ua' } as never))
            .toStrictEqual({
                id: 's2', courseId: 'c', courseTitle: null, title: 'T', status: 'draft', startsAt: null, endsAt: null, location: null,
                capacity: null, enrollmentOpen: true, isImplicit: false, createdBy: 1, createdAt: 'ca', updatedAt: 'ua',
                instructors: [], enrollmentCount: 0,
            });
    });

    it('toAcademyLessonProgress / toAcademyOutcomeResult / toAcademyEnrollment', () => {
        expect(toAcademyLessonProgress({ id: 'lp', enrollment_id: 'e', lesson_id: 'l', completed_by: 11, completed_at: 'ca', secret_LEAK: 1 } as never))
            .toStrictEqual({ id: 'lp', enrollmentId: 'e', lessonId: 'l', completedBy: 11, completedAt: 'ca' });
        expect(toAcademyOutcomeResult({ id: 'or', enrollment_id: 'e', outcome_id: 'o', verdict: 'pass', assessed_by: 12, assessed_at: 'aa', secret_LEAK: 1 } as never))
            .toStrictEqual({ id: 'or', enrollmentId: 'e', outcomeId: 'o', verdict: 'pass', assessedBy: 12, assessedAt: 'aa' });
        expect(toAcademyEnrollment({
            id: 'e', session_id: 's', student_id: 20, source: 'assigned', status: 'completed', assigned_by: 11, recommended_by: 12,
            recommended_at: 'ra', certified_by: 13, completed_at: 'ca', enrolled_at: 'ea', secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 'e', sessionId: 's', studentId: 20, student: null, source: 'assigned', status: 'completed', assignedBy: 11,
            recommendedBy: 12, recommendedAt: 'ra', certifiedBy: 13, completedAt: 'ca', enrolledAt: 'ea',
            lessonProgress: [], outcomeResults: [],
        });
        expect(toAcademyEnrollment({ id: 'e2', session_id: 's', student_id: 20, source: 'self', status: 'enrolled', enrolled_at: 'ea' } as never))
            .toStrictEqual({
                id: 'e2', sessionId: 's', studentId: 20, student: null, source: 'self', status: 'enrolled', assignedBy: null,
                recommendedBy: null, recommendedAt: null, certifiedBy: null, completedAt: null, enrolledAt: 'ea',
                lessonProgress: [], outcomeResults: [],
            });
    });
});

describe('blueprint mappers', () => {
    const PARTY = { id: 11, name: 'Crafter', avatar_url: 'c.png', rsi_handle: 'crafter', deleted_at: null, discord_id: 'LEAK' };

    it('toBlueprint maps the row and the live owner card', () => {
        expect(toBlueprint({
            id: 1, owner_id: 11, qm_catalog_id: 5, item_name: 'P4-AR', category: 'weapon', notes: 'n', offers_crafting: true,
            created_at: 'c', updated_at: 'u', owner: PARTY, secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 1, ownerId: 11, qmCatalogId: 5, itemName: 'P4-AR', category: 'weapon', notes: 'n', offersCrafting: true,
            createdAt: 'c', updatedAt: 'u', owner: { id: 11, name: 'Crafter', avatarUrl: 'c.png', rsiHandle: 'crafter' },
        });
    });

    it('toBlueprint withholds a soft-deleted owner and defaults sparse columns', () => {
        expect(toBlueprint({
            id: 2, owner_id: 11, item_name: 'X', offers_crafting: 'yes', created_at: 'c', updated_at: 'u',
            owner: { ...PARTY, deleted_at: '2026-01-01' },
        } as never)).toStrictEqual({
            id: 2, ownerId: 11, qmCatalogId: null, itemName: 'X', category: null, notes: null, offersCrafting: false,
            createdAt: 'c', updatedAt: 'u', owner: undefined,
        });
        expect(toBlueprint({ id: 3, owner_id: 11, item_name: 'X', offers_crafting: false, created_at: 'c', updated_at: 'u', owner: null } as never).owner)
            .toBeUndefined();
        expect(toBlueprint({
            id: 4, owner_id: 11, item_name: 'X', offers_crafting: false, created_at: 'c', updated_at: 'u',
            owner: { id: 11, name: 'N', avatar_url: null, rsi_handle: null, deleted_at: null },
        } as never).owner).toStrictEqual({ id: 11, name: 'N', avatarUrl: null, rsiHandle: null });
    });

    it('toCraftableItem takes only the item identity columns (owner_id cannot ride through)', () => {
        expect(toCraftableItem({ qm_catalog_id: 5, item_name: 'P4-AR', category: 'weapon', owner_id: 11 } as never))
            .toStrictEqual({ qmCatalogId: 5, itemName: 'P4-AR', category: 'weapon' });
        expect(toCraftableItem({ qm_catalog_id: null, item_name: 'X', category: null }))
            .toStrictEqual({ qmCatalogId: null, itemName: 'X', category: null });
    });

    it('toBlueprintRequest maps a full row, parsing a bigint price string', () => {
        expect(toBlueprintRequest({
            id: 1, requester_id: 20, crafter_id: 11, blueprint_id: 1, qm_catalog_id: 5, item_name: 'P4-AR', quantity: 3,
            materials_note: 'mats', offer_price_uec: '9007199254740993', status: 'claimed', claimed_at: 'cl', ready_at: 'rd',
            delivered_at: 'dl', completed_at: 'cp', cancelled_at: 'cn', cancel_reason: 'why', created_at: 'c', updated_at: 'u',
            requester: { ...PARTY, id: 20, name: 'Req' }, crafter: PARTY, secret_LEAK: 1,
        } as never)).toStrictEqual({
            id: 1, requesterId: 20, crafterId: 11, blueprintId: 1, qmCatalogId: 5, itemName: 'P4-AR', quantity: 3,
            materialsNote: 'mats', offerPriceUec: 9007199254740992, status: 'claimed', claimedAt: 'cl', readyAt: 'rd',
            deliveredAt: 'dl', completedAt: 'cp', cancelledAt: 'cn', cancelReason: 'why', createdAt: 'c', updatedAt: 'u',
            requester: { id: 20, name: 'Req', avatarUrl: 'c.png', rsiHandle: 'crafter' },
            crafter: { id: 11, name: 'Crafter', avatarUrl: 'c.png', rsiHandle: 'crafter' },
        });
    });

    it('toBlueprintRequest defaults sparse columns; a 0 price stays 0; deleted parties are withheld', () => {
        const sparse = toBlueprintRequest({
            id: 2, requester_id: 20, item_name: 'X', quantity: null, offer_price_uec: null, status: 'open', created_at: 'c', updated_at: 'u',
            requester: { ...PARTY, deleted_at: 'gone' }, crafter: null,
        } as never);
        expect(sparse).toStrictEqual({
            id: 2, requesterId: 20, crafterId: null, blueprintId: null, qmCatalogId: null, itemName: 'X', quantity: 1,
            materialsNote: null, offerPriceUec: null, status: 'open', claimedAt: null, readyAt: null, deliveredAt: null,
            completedAt: null, cancelledAt: null, cancelReason: null, createdAt: 'c', updatedAt: 'u',
            requester: undefined, crafter: undefined,
        });
        expect(toBlueprintRequest({ id: 3, requester_id: 20, item_name: 'X', quantity: 1, offer_price_uec: 0, status: 'open', created_at: 'c', updated_at: 'u' } as never).offerPriceUec)
            .toBe(0);
        expect(toBlueprintRequest({ id: 4, requester_id: 20, item_name: 'X', quantity: 1, status: 'open', created_at: 'c', updated_at: 'u' } as never).offerPriceUec)
            .toBeNull();
    });
});
