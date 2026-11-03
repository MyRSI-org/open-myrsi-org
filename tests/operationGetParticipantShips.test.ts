import { describe, it, expect, vi, beforeEach } from 'vitest';

// operation:get_participant_ships must gate on the FULL per-op
// visibility predicate (assertOpVisibleToUser), not the existence-only
// verifyOperationAccess. Mocks the db barrel so we assert the handler WIRING
// (a revert to verifyOperationAccess would let the read through → test fails).

const spies = vi.hoisted(() => ({
    assertOpVisibleToUser: vi.fn<(opId: string, user: unknown, opts?: unknown) => Promise<void>>(),
    verifyOperationAccess: vi.fn(),
    getFullOperationDetails: vi.fn(),
    getUserShipsByUserIds: vi.fn(),
    extractTemplatePayloadFromOperation: vi.fn(),
}));

vi.mock('../lib/db', () => spies);
// operations.ts also imports discord + mappers + clearance + aiRateLimit, none
// of which are exercised by get_participant_ships — stub the side-effecting ones.
vi.mock('../lib/discord', () => ({
    createGuildScheduledEvent: vi.fn(), deleteGuildScheduledEvent: vi.fn(), updateGuildScheduledEvent: vi.fn(),
    listGuildChannels: vi.fn(), postOperationAnnouncementEmbed: vi.fn(), editOperationAnnouncementEmbed: vi.fn(),
    deleteDiscordChannelMessage: vi.fn(),
}));

import { operationActions } from '../api/actions/operations';

const lowPriv = { id: 6, role: 'Member', permissions: ['operations:view'], clearanceLevel: { level: 0 }, limitingMarkers: [] };

beforeEach(() => {
    spies.assertOpVisibleToUser.mockReset();
    spies.getFullOperationDetails.mockReset();
    spies.getUserShipsByUserIds.mockReset();
    spies.getFullOperationDetails.mockResolvedValue({ participants: [{ userId: 2 }] });
    spies.getUserShipsByUserIds.mockResolvedValue([{ id: 1, name: 'Ship' }]);
});

describe('operation:get_participant_ships visibility gate (M1)', () => {
    it('rejects when the op is not visible to the caller, BEFORE reading ships', async () => {
        spies.assertOpVisibleToUser.mockRejectedValue(new Error('Insufficient clearance to act on this operation.'));
        await expect(
            (operationActions as Record<string, (p: unknown) => Promise<unknown>>)['operation:get_participant_ships']({ operationId: 'op1', userIds: [2], user: lowPriv }),
        ).rejects.toThrow(/clearance/i);
        expect(spies.assertOpVisibleToUser).toHaveBeenCalledWith('op1', lowPriv, { access: 'read' });
        expect(spies.getUserShipsByUserIds).not.toHaveBeenCalled();
    });

    it('returns participant ships once the op IS visible', async () => {
        spies.assertOpVisibleToUser.mockResolvedValue(undefined);
        const ships = await (operationActions as Record<string, (p: unknown) => Promise<unknown>>)['operation:get_participant_ships']({ operationId: 'op1', userIds: [2], user: lowPriv });
        expect(spies.assertOpVisibleToUser).toHaveBeenCalledWith('op1', lowPriv, { access: 'read' });
        expect(ships).toEqual([{ id: 1, name: 'Ship' }]);
    });

    it('does NOT fall back to existence-only verifyOperationAccess', async () => {
        spies.assertOpVisibleToUser.mockResolvedValue(undefined);
        await (operationActions as Record<string, (p: unknown) => Promise<unknown>>)['operation:get_participant_ships']({ operationId: 'op1', userIds: [2], user: lowPriv });
        expect(spies.verifyOperationAccess).not.toHaveBeenCalled();
    });
});

// Extracting a template from an op pulls its full plan — must gate on op
// visibility too (not just operations:create).
describe('operation:template:from_operation visibility gate (sweep / H2 class)', () => {
    beforeEach(() => { spies.extractTemplatePayloadFromOperation.mockReset().mockResolvedValue({ phases: [] }); });

    it('rejects extracting a template from an op the caller cannot see', async () => {
        spies.assertOpVisibleToUser.mockRejectedValue(new Error('Insufficient clearance to act on this operation.'));
        await expect(
            (operationActions as Record<string, (p: unknown) => Promise<unknown>>)['operation:template:from_operation']({ operationId: 'op1', user: lowPriv }),
        ).rejects.toThrow(/clearance/i);
        expect(spies.extractTemplatePayloadFromOperation).not.toHaveBeenCalled();
    });

    it('extracts the template once the op is visible', async () => {
        spies.assertOpVisibleToUser.mockResolvedValue(undefined);
        await (operationActions as Record<string, (p: unknown) => Promise<unknown>>)['operation:template:from_operation']({ operationId: 'op1', user: lowPriv });
        expect(spies.assertOpVisibleToUser).toHaveBeenCalledWith('op1', lowPriv, { access: 'read' });
        expect(spies.extractTemplatePayloadFromOperation).toHaveBeenCalledWith('op1');
    });
});
