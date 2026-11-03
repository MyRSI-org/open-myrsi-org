import { describe, it, expect, beforeEach, vi } from 'vitest';

// =============================================================================
// lib/db/academy.ts — CURRICULUM: modules, lessons, outcomes, ordering
// =============================================================================
// Pins the curriculum write path: every child write resolves its owning course with
// the SAME opaque denial as a missing course (no existence oracle), is gated to the
// course's instructors / academy:manage, validates (never coerces) sort positions,
// sanitises lesson content and video links at the write boundary, and reorders
// through the single atomic academy_apply_order() function — failing CLOSED when it
// is absent rather than falling back to N partial updates.
vi.mock('../lib/db/common.js', async () => {
    const hh = await import('./cov-db-academy-harness');
    return { supabase: hh.supabaseStub, handleSupabaseError: hh.handleSupabaseError, broadcastToOrg: hh.broadcastToOrg };
});
vi.mock('../lib/db/system.js', async () => ({ awardCertification: (await import('./cov-db-academy-harness')).awardCertification }));
vi.mock('../lib/db/notifications.js', async () => ({ createNotification: (await import('./cov-db-academy-harness')).createNotification }));
vi.mock('../lib/db/clientRoleLock.js', async () => ({ requireClientRoleId: (await import('./cov-db-academy-harness')).requireClientRoleId }));
vi.mock('../lib/log.js', async () => ({ log: (await import('./cov-db-academy-harness')).logSpy }));

import {
    sb, on, resetHarness, queriesOn, writesOn, broadcasts, rpcReturns, assertNoWildcardSelects,
    argOf, colsOf, eqsOf, payloadOf, seedCourse, seedCourseInstructor, MODULE_COLS, COURSE_GUARD_COLS,
} from './cov-db-academy-harness';
import {
    createModule, updateModule, deleteModule, createLesson, updateLesson, deleteLesson,
    createOutcome, updateOutcome, deleteOutcome, reorderModules, reorderLessons, reorderOutcomes,
} from '../lib/db/academy';
import { SecurityDenial } from '../lib/errors';

beforeEach(() => resetHarness());

const SORT_ERR = 'sortOrder must be a whole number between 0 and 1000000.';
const BAD_SORTS: unknown[] = [-1, 1.5, 1_000_001, '5', Number.NaN];

/** Module 5 belongs to course c1, which exists. */
function seedModule(moduleId = 5, courseId = 'c1'): void {
    on('academy_modules', { kind: 'select', cols: 'course_id', eq: { id: moduleId } }, { data: { course_id: courseId } });
}
function seedLesson(lessonId = 8, moduleId = 5): void {
    on('academy_lessons', { kind: 'select', cols: 'module_id', eq: { id: lessonId } }, { data: { module_id: moduleId } });
}
function seedOutcome(outcomeId = 3, courseId = 'c1'): void {
    on('academy_outcomes', { kind: 'select', cols: 'course_id', eq: { id: outcomeId } }, { data: { course_id: courseId } });
}

// ════════════════════════════════════════════════════════════════════════════
describe('createModule', () => {
    it('a non-instructor is denied before validation and nothing is written', async () => {
        seedCourse();
        await expect(createModule('c1', 99, false, { title: 'M' })).rejects.toThrow('You are not an instructor of this course.');
        expect(queriesOn('academy_modules')).toEqual([]);
    });

    it('requires a title', async () => {
        seedCourse();
        await expect(createModule('c1', 1, true, { title: '  ' })).rejects.toThrow('Module title is required.');
        expect(queriesOn('academy_modules')).toEqual([]);
    });

    it('appends after the current maximum when no position is supplied', async () => {
        seedCourse();
        seedCourseInstructor('c1', 55);
        on('academy_modules', { kind: 'select', cols: 'sort_order' }, { data: { sort_order: 30 } });
        on('academy_modules', { kind: 'insert' }, { data: { id: 4, course_id: 'c1', title: 'Nav', description: null, sort_order: 40, created_at: 't' } });
        const out = await createModule('c1', 55, false, { title: ' Nav ', description: '  ' });
        const [probe] = queriesOn('academy_modules', 'select');
        expect(eqsOf(probe)).toEqual({ course_id: 'c1' });
        expect(argOf(probe, 'order')).toEqual(['sort_order', { ascending: false }]);
        expect(argOf(probe, 'limit')).toEqual([1]);
        expect(probe.terminal).toBe('maybeSingle');
        const [ins] = queriesOn('academy_modules', 'insert');
        expect(payloadOf(ins)).toEqual({ course_id: 'c1', title: 'Nav', description: null, sort_order: 40 });
        expect(colsOf(ins)).toBe(MODULE_COLS);
        expect(out).toEqual({ id: 4, courseId: 'c1', title: 'Nav', description: null, sortOrder: 40, lessons: [] });
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
        assertNoWildcardSelects();
    });

    it('the first module of an empty course lands at SORT_STEP (10)', async () => {
        seedCourse();
        on('academy_modules', { kind: 'insert' }, { data: { id: 1, course_id: 'c1', title: 'A', description: 'd', sort_order: 10, created_at: 't' } });
        await createModule('c1', 1, true, { title: 'A', description: ' d ' });
        expect(payloadOf(queriesOn('academy_modules', 'insert')[0])).toMatchObject({ sort_order: 10, description: 'd' });
    });

    it('an explicit valid position is used verbatim (0 is the front, not "missing") with no order probe', async () => {
        seedCourse();
        on('academy_modules', { kind: 'insert' }, { data: { id: 1, course_id: 'c1', title: 'A', description: null, sort_order: 0, created_at: 't' } });
        await createModule('c1', 1, true, { title: 'A', sortOrder: 0 });
        expect(queriesOn('academy_modules', 'select')).toEqual([]);
        expect(payloadOf(queriesOn('academy_modules', 'insert')[0])).toMatchObject({ sort_order: 0 });
    });

    it.each(BAD_SORTS)('an explicit invalid position (%s) is REJECTED, never defaulted', async (sortOrder) => {
        seedCourse();
        await expect(createModule('c1', 1, true, { title: 'A', sortOrder: sortOrder as number })).rejects.toThrow(SORT_ERR);
        expect(queriesOn('academy_modules', 'insert')).toEqual([]);
    });

    it('an order-probe read fault is not swallowed (no tie with the first row)', async () => {
        seedCourse();
        on('academy_modules', { kind: 'select', cols: 'sort_order' }, { error: { code: 'X' } });
        await expect(createModule('c1', 1, true, { title: 'A' })).rejects.toThrow('Failed to resolve module order');
        expect(queriesOn('academy_modules', 'insert')).toEqual([]);
    });

    it('an insert error / empty return both fail with the generic message', async () => {
        seedCourse();
        on('academy_modules', { kind: 'insert' }, { error: { code: 'X' } });
        await expect(createModule('c1', 1, true, { title: 'A', sortOrder: 1 })).rejects.toThrow('Failed to create module');
        resetHarness();
        seedCourse();
        await expect(createModule('c1', 1, true, { title: 'A', sortOrder: 1 })).rejects.toThrow('Failed to create module');
        expect(broadcasts()).toEqual([]);
    });
});

describe('module child guard (moduleCourse)', () => {
    it('an unknown module is the SAME opaque denial as an unknown course, and no course read happens', async () => {
        const err = await updateModule(404, 1, true, { title: 'x' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('This course is not available.');
        expect((err as SecurityDenial).fields).toEqual({ moduleId: 404 });
        expect(queriesOn('academy_courses')).toEqual([]);
        expect(writesOn('academy_modules', 'update')).toEqual([]);
    });

    it('a module whose course is gone is denied', async () => {
        seedModule(5, 'gone');
        await expect(deleteModule(5, 1, true)).rejects.toThrow('This course is not available.');
        const [cq] = queriesOn('academy_courses');
        expect(colsOf(cq)).toBe(COURSE_GUARD_COLS);
        expect(eqsOf(cq)).toEqual({ id: 'gone' });
        expect(queriesOn('academy_modules', 'delete')).toEqual([]);
    });
});

describe('updateModule', () => {
    it('patches exactly the supplied fields, scoped by id', async () => {
        seedModule(); seedCourse();
        await updateModule(5, 1, true, { title: ' T ', description: null, sortOrder: 20 });
        const [upd] = queriesOn('academy_modules', 'update');
        expect(payloadOf(upd)).toEqual({ title: 'T', description: null, sort_order: 20 });
        expect(eqsOf(upd)).toEqual({ id: 5 });
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('an empty input writes an empty patch (no stray fields)', async () => {
        seedModule(); seedCourse();
        await updateModule(5, 1, true, {});
        expect(writesOn('academy_modules', 'update')).toEqual([{}]);
    });

    it('description text is trimmed', async () => {
        seedModule(); seedCourse();
        await updateModule(5, 1, true, { description: '  hello ' });
        expect(writesOn('academy_modules', 'update')).toEqual([{ description: 'hello' }]);
    });

    it('refuses a blank title and an invalid position', async () => {
        seedModule(); seedCourse();
        await expect(updateModule(5, 1, true, { title: '' })).rejects.toThrow('Module title is required.');
        await expect(updateModule(5, 1, true, { sortOrder: -5 })).rejects.toThrow(SORT_ERR);
        expect(writesOn('academy_modules', 'update')).toEqual([]);
    });

    it('a non-instructor is denied', async () => {
        seedModule(); seedCourse();
        await expect(updateModule(5, 99, false, { title: 'x' })).rejects.toBeInstanceOf(SecurityDenial);
        expect(writesOn('academy_modules', 'update')).toEqual([]);
    });

    it('an update error surfaces the generic message', async () => {
        seedModule(); seedCourse();
        on('academy_modules', { kind: 'update' }, { error: { code: 'X' } });
        await expect(updateModule(5, 1, true, { title: 'x' })).rejects.toThrow('Failed to update module');
        expect(broadcasts()).toEqual([]);
    });
});

describe('deleteModule', () => {
    it('deletes by id after the edit gate', async () => {
        seedModule(); seedCourse(); seedCourseInstructor('c1', 55);
        await deleteModule(5, 55, false);
        expect(eqsOf(queriesOn('academy_modules', 'delete')[0])).toEqual({ id: 5 });
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('a non-instructor is denied', async () => {
        seedModule(); seedCourse();
        await expect(deleteModule(5, 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_modules', 'delete')).toEqual([]);
    });

    it('a delete error surfaces the generic message', async () => {
        seedModule(); seedCourse();
        on('academy_modules', { kind: 'delete' }, { error: { code: 'X' } });
        await expect(deleteModule(5, 1, true)).rejects.toThrow('Failed to delete module');
    });
});

// ════════════════════════════════════════════════════════════════════════════
const DOC_WITH_IFRAME = JSON.stringify({
    type: 'doc',
    content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] },
        { type: 'iframe', attrs: { src: 'https://evil.example/x' } },
    ],
});

describe('createLesson', () => {
    it('requires a title (after the edit gate)', async () => {
        seedModule(); seedCourse();
        await expect(createLesson(5, 1, true, { title: '' })).rejects.toThrow('Lesson title is required.');
        expect(queriesOn('academy_lessons')).toEqual([]);
    });

    it('a non-instructor is denied', async () => {
        seedModule(); seedCourse();
        await expect(createLesson(5, 99, false, { title: 'L' })).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_lessons')).toEqual([]);
    });

    it('an unknown module is denied opaquely', async () => {
        await expect(createLesson(404, 1, true, { title: 'L' })).rejects.toThrow('This course is not available.');
    });

    it('sanitises content to the minimal allowlist, keeps an allow-listed video host, appends after the max', async () => {
        seedModule(); seedCourse();
        on('academy_lessons', { kind: 'select', cols: 'sort_order' }, { data: { sort_order: 70 } });
        await createLesson(5, 1, true, {
            title: ' L1 ', content: DOC_WITH_IFRAME, videoUrl: 'https://www.youtube.com/watch?v=abc', estimatedMinutes: 15,
        });
        const [probe] = queriesOn('academy_lessons', 'select');
        expect(eqsOf(probe)).toEqual({ module_id: 5 });
        expect(argOf(probe, 'order')).toEqual(['sort_order', { ascending: false }]);
        const [row] = writesOn('academy_lessons', 'insert') as Array<Record<string, unknown>>;
        expect(row).toMatchObject({ module_id: 5, title: 'L1', video_url: 'https://www.youtube.com/watch?v=abc', sort_order: 80, estimated_minutes: 15 });
        const stored = JSON.parse(row.content as string);
        expect(stored.type).toBe('doc');
        expect(JSON.stringify(stored)).toContain('"hi"');
        expect(JSON.stringify(stored)).not.toContain('iframe');
        expect(JSON.stringify(stored)).not.toContain('evil.example');
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('a non-allow-listed video host, a private host and a script url are all nulled; absent minutes are null', async () => {
        seedModule(); seedCourse();
        for (const videoUrl of ['https://evil.example/v.mp4', 'http://127.0.0.1/x', 'javascript:alert(1)', 'not a url']) {
            await createLesson(5, 1, true, { title: 'L', videoUrl, sortOrder: 1 });
        }
        for (const row of writesOn('academy_lessons', 'insert') as Array<Record<string, unknown>>) {
            expect(row.video_url).toBeNull();
            expect(row.estimated_minutes).toBeNull();
        }
    });

    it('a discord: link passes the public-link check but is not a video host → null', async () => {
        seedModule(); seedCourse();
        await createLesson(5, 1, true, { title: 'L', videoUrl: 'discord://invite/abc', sortOrder: 1 });
        expect((writesOn('academy_lessons', 'insert')[0] as Record<string, unknown>).video_url).toBeNull();
    });

    it.each([
        ['plain text', 'just words'],
        ['a non-doc JSON object', { type: 'paragraph', content: [] }],
        ['a number', 42],
        ['null', null],
    ])('content that is %s persists as null', async (_label, content) => {
        seedModule(); seedCourse();
        await createLesson(5, 1, true, { title: 'L', content: content as string, sortOrder: 2 });
        expect((writesOn('academy_lessons', 'insert')[0] as Record<string, unknown>).content).toBeNull();
    });

    it('content supplied as an already-parsed doc object is sanitised too', async () => {
        seedModule(); seedCourse();
        const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'obj' }] }, { type: 'image', attrs: { src: 'https://x/y.png' } }] };
        await createLesson(5, 1, true, { title: 'L', content: doc as unknown as string, sortOrder: 2 });
        const stored = (writesOn('academy_lessons', 'insert')[0] as Record<string, unknown>).content as string;
        expect(stored).toContain('"obj"');
        expect(stored).not.toContain('image');
    });

    it('an invalid explicit position is rejected', async () => {
        seedModule(); seedCourse();
        await expect(createLesson(5, 1, true, { title: 'L', sortOrder: 2.5 })).rejects.toThrow(SORT_ERR);
        // from() is evaluated before the payload, so a builder exists — but it never
        // received an insert (or any other) call.
        expect(writesOn('academy_lessons', 'insert')).toEqual([]);
        expect(queriesOn('academy_lessons').every(q => q.ops.length === 0)).toBe(true);
        expect(broadcasts()).toEqual([]);
    });

    it('order-probe and insert faults surface their messages', async () => {
        seedModule(); seedCourse();
        on('academy_lessons', { kind: 'select', cols: 'sort_order' }, { error: { code: 'X' } });
        await expect(createLesson(5, 1, true, { title: 'L' })).rejects.toThrow('Failed to resolve lesson order');
        expect(queriesOn('academy_lessons', 'insert')).toEqual([]);
        resetHarness();
        seedModule(); seedCourse();
        on('academy_lessons', { kind: 'insert' }, { error: { code: 'X' } });
        await expect(createLesson(5, 1, true, { title: 'L' })).rejects.toThrow('Failed to create lesson');
        expect(broadcasts()).toEqual([]);
    });
});

describe('updateLesson / deleteLesson (lessonCourse guard)', () => {
    it('an unknown lesson is the opaque course denial, with no module/course read', async () => {
        const err = await updateLesson(404, 1, true, { title: 'x' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('This course is not available.');
        expect((err as SecurityDenial).fields).toEqual({ lessonId: 404 });
        expect(queriesOn('academy_modules')).toEqual([]);
        expect(queriesOn('academy_courses')).toEqual([]);
    });

    it('a lesson whose module is gone is denied', async () => {
        seedLesson(8, 77);
        await expect(deleteLesson(8, 1, true)).rejects.toThrow('This course is not available.');
        expect(queriesOn('academy_lessons', 'delete')).toEqual([]);
    });

    it('patches exactly the supplied, sanitised fields', async () => {
        seedLesson(); seedModule(); seedCourse();
        await updateLesson(8, 1, true, {
            title: ' New ', content: 'not json', videoUrl: 'https://vimeo.com/123', sortOrder: 0, estimatedMinutes: null,
        });
        const [upd] = queriesOn('academy_lessons', 'update');
        expect(payloadOf(upd)).toEqual({ title: 'New', content: null, video_url: 'https://vimeo.com/123', sort_order: 0, estimated_minutes: null });
        expect(eqsOf(upd)).toEqual({ id: 8 });
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('an empty input writes an empty patch; minutes are passed through', async () => {
        seedLesson(); seedModule(); seedCourse();
        await updateLesson(8, 1, true, {});
        await updateLesson(8, 1, true, { estimatedMinutes: 9 });
        expect(writesOn('academy_lessons', 'update')).toEqual([{}, { estimated_minutes: 9 }]);
    });

    it('refuses a blank title / invalid position, and a non-instructor', async () => {
        seedLesson(); seedModule(); seedCourse();
        await expect(updateLesson(8, 1, true, { title: ' ' })).rejects.toThrow('Lesson title is required.');
        await expect(updateLesson(8, 1, true, { sortOrder: 1_000_001 })).rejects.toThrow(SORT_ERR);
        await expect(updateLesson(8, 99, false, { title: 'x' })).rejects.toBeInstanceOf(SecurityDenial);
        expect(writesOn('academy_lessons', 'update')).toEqual([]);
    });

    it('update / delete errors surface their messages', async () => {
        seedLesson(); seedModule(); seedCourse();
        on('academy_lessons', { kind: 'update' }, { error: { code: 'X' } });
        on('academy_lessons', { kind: 'delete' }, { error: { code: 'X' } });
        await expect(updateLesson(8, 1, true, { title: 'x' })).rejects.toThrow('Failed to update lesson');
        await expect(deleteLesson(8, 1, true)).rejects.toThrow('Failed to delete lesson');
        expect(broadcasts()).toEqual([]);
    });

    it('deleteLesson deletes by id for an assigned instructor', async () => {
        seedLesson(); seedModule(); seedCourse(); seedCourseInstructor('c1', 55);
        await deleteLesson(8, 55, false);
        expect(eqsOf(queriesOn('academy_lessons', 'delete')[0])).toEqual({ id: 8 });
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('deleteLesson denies a non-instructor', async () => {
        seedLesson(); seedModule(); seedCourse();
        await expect(deleteLesson(8, 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_lessons', 'delete')).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('createOutcome', () => {
    it('requires a title; a non-instructor is denied', async () => {
        seedCourse();
        await expect(createOutcome('c1', 1, true, { title: '' })).rejects.toThrow('Outcome title is required.');
        await expect(createOutcome('c1', 99, false, { title: 'O' })).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_outcomes')).toEqual([]);
    });

    it('defaults required=true and appends after the max', async () => {
        seedCourse();
        on('academy_outcomes', { kind: 'select', cols: 'sort_order' }, { data: { sort_order: 5 } });
        await createOutcome('c1', 1, true, { title: ' Navigate ', description: ' d ' });
        const [probe] = queriesOn('academy_outcomes', 'select');
        expect(eqsOf(probe)).toEqual({ course_id: 'c1' });
        expect(writesOn('academy_outcomes', 'insert')).toEqual([{ course_id: 'c1', title: 'Navigate', description: 'd', sort_order: 15, required: true }]);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('the first outcome of a course lands at SORT_STEP (10)', async () => {
        seedCourse();
        await createOutcome('c1', 1, true, { title: 'First' });
        expect(writesOn('academy_outcomes', 'insert')).toEqual([{ course_id: 'c1', title: 'First', description: null, sort_order: 10, required: true }]);
    });

    it('required:false is honoured; an explicit position skips the probe', async () => {
        seedCourse();
        await createOutcome('c1', 1, true, { title: 'O', required: false, sortOrder: 7, description: null });
        expect(queriesOn('academy_outcomes', 'select')).toEqual([]);
        expect(writesOn('academy_outcomes', 'insert')).toEqual([{ course_id: 'c1', title: 'O', description: null, sort_order: 7, required: false }]);
    });

    it('rejects an invalid position; order-probe and insert faults surface', async () => {
        seedCourse();
        await expect(createOutcome('c1', 1, true, { title: 'O', sortOrder: -1 })).rejects.toThrow(SORT_ERR);
        on('academy_outcomes', { kind: 'select', cols: 'sort_order' }, { error: { code: 'X' } });
        await expect(createOutcome('c1', 1, true, { title: 'O' })).rejects.toThrow('Failed to resolve outcome order');
        on('academy_outcomes', { kind: 'insert' }, { error: { code: 'X' } });
        await expect(createOutcome('c1', 1, true, { title: 'O', sortOrder: 1 })).rejects.toThrow('Failed to create outcome');
        expect(broadcasts()).toEqual([]);
    });
});

describe('updateOutcome / deleteOutcome (outcomeCourse guard)', () => {
    it('an unknown outcome is the opaque course denial, no course read', async () => {
        const err = await updateOutcome(404, 1, true, { title: 'x' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('This course is not available.');
        expect((err as SecurityDenial).fields).toEqual({ outcomeId: 404 });
        expect(queriesOn('academy_courses')).toEqual([]);
    });

    it('an outcome whose course is gone is denied', async () => {
        seedOutcome(3, 'gone');
        await expect(deleteOutcome(3, 1, true)).rejects.toThrow('This course is not available.');
        expect(queriesOn('academy_outcomes', 'delete')).toEqual([]);
    });

    it('patches exactly the supplied fields; required is coerced to a boolean', async () => {
        seedOutcome(); seedCourse();
        await updateOutcome(3, 1, true, { title: ' T ', description: '  ', sortOrder: 30, required: 0 as unknown as boolean });
        const [upd] = queriesOn('academy_outcomes', 'update');
        expect(payloadOf(upd)).toEqual({ title: 'T', description: null, sort_order: 30, required: false });
        expect(eqsOf(upd)).toEqual({ id: 3 });
        await updateOutcome(3, 1, true, {});
        await updateOutcome(3, 1, true, { required: true });
        expect(writesOn('academy_outcomes', 'update').slice(1)).toEqual([{}, { required: true }]);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }, { courseId: 'c1' }, { courseId: 'c1' }]);
    });

    it('refuses a blank title / invalid position / non-instructor', async () => {
        seedOutcome(); seedCourse();
        await expect(updateOutcome(3, 1, true, { title: '' })).rejects.toThrow('Outcome title is required.');
        await expect(updateOutcome(3, 1, true, { sortOrder: 'x' as unknown as number })).rejects.toThrow(SORT_ERR);
        await expect(updateOutcome(3, 99, false, { title: 'x' })).rejects.toBeInstanceOf(SecurityDenial);
        expect(writesOn('academy_outcomes', 'update')).toEqual([]);
    });

    it('update / delete errors surface; delete is scoped by id', async () => {
        seedOutcome(); seedCourse(); seedCourseInstructor('c1', 55);
        await deleteOutcome(3, 55, false);
        expect(eqsOf(queriesOn('academy_outcomes', 'delete')[0])).toEqual({ id: 3 });
        on('academy_outcomes', { kind: 'update' }, { error: { code: 'X' } });
        on('academy_outcomes', { kind: 'delete' }, { error: { code: 'X' } });
        await expect(updateOutcome(3, 1, true, { title: 'x' })).rejects.toThrow('Failed to update outcome');
        await expect(deleteOutcome(3, 1, true)).rejects.toThrow('Failed to delete outcome');
    });

    it('deleteOutcome denies a non-instructor', async () => {
        seedOutcome(); seedCourse();
        await expect(deleteOutcome(3, 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(queriesOn('academy_outcomes', 'delete')).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
describe('reorder — list validation (normalizeOrder)', () => {
    it.each([
        ['not an array', 'nope', 'reorderModules: an ordered list of ids is required.'],
        ['empty', [], 'reorderModules: an ordered list of ids is required.'],
        ['over the 200 cap (rejected, never sliced)', Array.from({ length: 201 }, (_, i) => i + 1), 'reorderModules: cannot reorder more than 200 items at once.'],
        ['containing a non-id', [1, 'two', 3], 'reorderModules: the ordered list contained something that is not an id.'],
        ['containing zero', [0, 1], 'reorderModules: the ordered list contained something that is not an id.'],
        ['containing a fraction', [1, 2.5], 'reorderModules: the ordered list contained something that is not an id.'],
        ['containing duplicates (refused, never deduped)', [1, 2, 1], 'reorderModules: the ordered list contained duplicates.'],
    ])('rejects a list %s, with no rpc call', async (_label, ids, message) => {
        seedCourse();
        await expect(reorderModules('c1', ids, 1, true)).rejects.toThrow(message);
        expect(sb.rpcCalls).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });

    it('exactly 200 ids is accepted', async () => {
        seedCourse();
        const ids = Array.from({ length: 200 }, (_, i) => i + 1);
        await reorderModules('c1', ids, 1, true);
        expect(sb.rpcCalls).toEqual([{ fn: 'academy_apply_order', args: { p_entity: 'modules', p_parent: 'c1', p_ids: ids } }]);
    });
});

describe('reorderModules / reorderOutcomes', () => {
    it('the edit gate runs BEFORE validation and the rpc', async () => {
        seedCourse();
        await expect(reorderModules('c1', [1, 2], 99, false)).rejects.toThrow('You are not an instructor of this course.');
        await expect(reorderOutcomes('c1', [1, 2], 99, false)).rejects.toThrow('You are not an instructor of this course.');
        expect(sb.rpcCalls).toEqual([]);
    });

    it('writes the whole order through ONE atomic rpc and broadcasts the course id', async () => {
        seedCourse(); seedCourseInstructor('c1', 55);
        await reorderModules('c1', [3, 1, 2], 55, false);
        await reorderOutcomes('c1', [9, 8], 55, false);
        expect(sb.rpcCalls).toEqual([
            { fn: 'academy_apply_order', args: { p_entity: 'modules', p_parent: 'c1', p_ids: [3, 1, 2] } },
            { fn: 'academy_apply_order', args: { p_entity: 'outcomes', p_parent: 'c1', p_ids: [9, 8] } },
        ]);
        // No per-row updates: the partial-write shape this replaced must not come back.
        expect(queriesOn('academy_modules')).toEqual([]);
        expect(queriesOn('academy_outcomes')).toEqual([]);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }, { courseId: 'c1' }]);
    });

    it.each(['42883', 'PGRST202'])('FAILS CLOSED when academy_apply_order is missing (%s)', async (code) => {
        seedCourse();
        rpcReturns({ error: { code, message: 'function academy_apply_order does not exist' } });
        await expect(reorderModules('c1', [1, 2], 1, true)).rejects.toThrow(/academy_apply_order is missing/);
        expect(queriesOn('academy_modules')).toEqual([]);
        expect(broadcasts()).toEqual([]);
    });

    it('an incomplete sibling list is a clear refusal', async () => {
        seedCourse();
        rpcReturns({ error: { code: 'P0001', message: 'ACADEMY_ORDER_INCOMPLETE: expected 3 got 2' } });
        await expect(reorderOutcomes('c1', [1, 2], 1, true)).rejects.toThrow('Reordering needs the complete list for this parent — send every sibling, not a subset.');
    });

    it('a foreign id is a SecurityDenial carrying the parent in its audit fields', async () => {
        seedCourse();
        rpcReturns({ error: { code: 'P0001', message: 'ACADEMY_ORDER_FOREIGN' } });
        const err = await reorderModules('c1', [1, 2], 1, true).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).message).toBe('Those items do not all belong to this course.');
        expect((err as SecurityDenial).fields).toEqual({ courseId: 'c1' });
    });

    it('any other rpc error (even one with no code/message) surfaces the generic message', async () => {
        seedCourse();
        rpcReturns({ error: { code: '40001', message: 'serialization failure' } });
        await expect(reorderModules('c1', [1], 1, true)).rejects.toThrow('Failed to reorder');
        rpcReturns({ error: {} });
        await expect(reorderModules('c1', [1], 1, true)).rejects.toThrow('Failed to reorder');
    });
});

describe('reorderLessons', () => {
    it.each([0, -3, 1.5, Number.NaN])('rejects an invalid module id (%s) before any read', async (moduleId) => {
        await expect(reorderLessons(moduleId, [1], 1, true)).rejects.toThrow('reorderLessons: a module id is required.');
        expect(sb.queries).toEqual([]);
        expect(sb.rpcCalls).toEqual([]);
    });

    it('an unknown module is the opaque course denial', async () => {
        await expect(reorderLessons(404, [1], 1, true)).rejects.toThrow('This course is not available.');
        expect(sb.rpcCalls).toEqual([]);
    });

    it('a non-instructor is denied', async () => {
        seedModule(); seedCourse();
        await expect(reorderLessons(5, [1], 99, false)).rejects.toBeInstanceOf(SecurityDenial);
        expect(sb.rpcCalls).toEqual([]);
    });

    it('validates with its own label', async () => {
        seedModule(); seedCourse();
        await expect(reorderLessons(5, [], 1, true)).rejects.toThrow('reorderLessons: an ordered list of ids is required.');
    });

    it('passes the module id as the (string) parent and broadcasts the owning course', async () => {
        seedModule(); seedCourse();
        await reorderLessons(5, [11, 10], 1, true);
        expect(sb.rpcCalls).toEqual([{ fn: 'academy_apply_order', args: { p_entity: 'lessons', p_parent: '5', p_ids: [11, 10] } }]);
        expect(broadcasts()).toEqual([{ courseId: 'c1' }]);
    });

    it('a foreign lesson id denial carries the module id in its audit fields', async () => {
        seedModule(); seedCourse();
        rpcReturns({ error: { message: 'ACADEMY_ORDER_FOREIGN' } });
        const err = await reorderLessons(5, [11], 1, true).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(SecurityDenial);
        expect((err as SecurityDenial).fields).toEqual({ moduleId: 5 });
    });
});
