// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    formatUserDateTime,
    formatUserDate,
    formatUserTime,
    formatOpDateTime,
    formatOpDate,
    formatOpTime,
    toLocalDatetimeValue,
    fromLocalDatetimeValue,
    formatRelativeTime,
    getUserTimezoneLabel,
    formatOpTimeWithZone,
    formatOpDateTimeWithZone,
    getDateFormatPresets,
    isValidDateFormat,
    detectBrowserTimezone,
    getCommonTimezones,
    getAllTimezones,
    isValidTimezone,
    formatCountdown,
} from '../lib/time';

// lib/time.ts renders UTC-stored timestamps in the viewer's chosen zone and preset.
// Time-zone independence: every assertion here holds on the local machine (AEST) and
// on CI (UTC). Explicit-zone cases pin the zone in the prefs; local-zone cases build
// the instant from LOCAL components (new Date(y, m, d, h, min)), so the rendered
// wall-clock is the same in every process zone. Locale independence: the presets force
// their own locale; the legacy no-prefs path uses the runtime locale, so it is
// asserted on locale-stable tokens only (4-digit year, 2-digit day, zero-padded time).

// ICU emits U+202F / U+00A0 before am/pm in some versions; compare on plain spaces.
const norm = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

// 2026-04-01 22:05 UTC — in Tokyo (UTC+9, no DST) that is 2026-04-02 07:05.
const INSTANT = '2026-04-01T22:05:00.000Z';
// 09:05 local wall-clock, whatever the process zone is.
const LOCAL_MORNING = new Date(2026, 3, 1, 9, 5).toISOString();

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('formatUserDateTime / formatUserDate / formatUserTime — the four presets', () => {
    it('compact_12h (default) renders DD MMM YY hh:mm am/pm in the requested zone', () => {
        expect(norm(formatUserDateTime(INSTANT, { timezone: 'UTC' }))).toBe('01 Apr 26, 10:05 pm');
        expect(norm(formatUserDate(INSTANT, { timezone: 'UTC' }))).toBe('01 Apr 26');
        expect(norm(formatUserTime(INSTANT, { timezone: 'UTC' }))).toBe('10:05 pm');
    });

    it('honours the viewer timezone, so the same instant reads differently across zones', () => {
        expect(norm(formatUserDateTime(INSTANT, { timezone: 'Asia/Tokyo' }))).toBe('02 Apr 26, 07:05 am');
        expect(norm(formatUserDate(INSTANT, { timezone: 'Asia/Tokyo' }))).toBe('02 Apr 26');
        expect(norm(formatUserTime(INSTANT, { timezone: 'Asia/Tokyo' }))).toBe('07:05 am');
    });

    it('iso_24h renders YYYY-MM-DD HH:mm, 24-hour', () => {
        const p = { timezone: 'UTC', dateFormat: 'iso_24h' };
        expect(norm(formatUserDateTime(INSTANT, p))).toBe('2026-04-01 22:05');
        expect(norm(formatUserDate(INSTANT, p))).toBe('2026-04-01');
        expect(norm(formatUserTime(INSTANT, p))).toBe('22:05');
    });

    it('us_12h renders MMM D, YYYY h:mm AM/PM', () => {
        const p = { timezone: 'UTC', dateFormat: 'us_12h' };
        expect(norm(formatUserDateTime(INSTANT, p))).toBe('Apr 1, 2026, 10:05 PM');
        expect(norm(formatUserDate(INSTANT, p))).toBe('Apr 1, 2026');
        expect(norm(formatUserTime(INSTANT, p))).toBe('10:05 PM');
    });

    it('de_24h renders space-separated DD MM YY HH:MM (the "/" separators are post-processed away)', () => {
        const p = { timezone: 'UTC', dateFormat: 'de_24h' };
        expect(norm(formatUserDateTime(INSTANT, p))).toBe('01 04 26, 22:05');
        expect(norm(formatUserDate(INSTANT, p))).toBe('01 04 26');
        expect(norm(formatUserTime(INSTANT, p))).toBe('22:05');
    });

    it('an unknown preset falls back to compact_12h rather than throwing', () => {
        expect(norm(formatUserDateTime(INSTANT, { timezone: 'UTC', dateFormat: 'rfc_2822' }))).toBe('01 Apr 26, 10:05 pm');
        expect(norm(formatUserDate(INSTANT, { timezone: 'UTC', dateFormat: '' }))).toBe('01 Apr 26');
    });

    it('a blank / whitespace timezone falls back to the runtime zone (local wall-clock)', () => {
        expect(norm(formatUserDateTime(LOCAL_MORNING, { timezone: '   ', dateFormat: 'iso_24h' }))).toBe('2026-04-01 09:05');
        expect(norm(formatUserDateTime(LOCAL_MORNING, { timezone: '', dateFormat: 'iso_24h' }))).toBe('2026-04-01 09:05');
        expect(norm(formatUserDateTime(LOCAL_MORNING))).toBe('01 Apr 26, 09:05 am');
    });

    it('returns an em dash for missing or unparseable input', () => {
        for (const bad of [undefined, null, '', 'not-a-date']) {
            expect(formatUserDateTime(bad, { timezone: 'UTC' })).toBe('—');
            expect(formatUserDate(bad, { timezone: 'UTC' })).toBe('—');
            expect(formatUserTime(bad, { timezone: 'UTC' })).toBe('—');
        }
    });

    it('builds each (preset, zone) formatter set once and reuses it from the cache', () => {
        const ctor = vi.spyOn(Intl, 'DateTimeFormat');
        const p = { timezone: 'Pacific/Auckland', dateFormat: 'us_12h' };
        formatUserDateTime(INSTANT, p);
        // dateTime + date + time formatters for this key.
        expect(ctor).toHaveBeenCalledTimes(3);
        expect(ctor).toHaveBeenCalledWith('en-US', expect.objectContaining({ timeZone: 'Pacific/Auckland', month: 'short' }));
        formatUserDate(INSTANT, p);
        formatUserTime(INSTANT, p);
        formatUserDateTime(INSTANT, p);
        expect(ctor).toHaveBeenCalledTimes(3);
    });
});

describe('legacy formatOp* helpers', () => {
    it('with prefs carrying a zone or a preset, delegate to the preset formatters', () => {
        expect(norm(formatOpDateTime(INSTANT, { timezone: 'UTC' }))).toBe('01 Apr 26, 10:05 pm');
        expect(norm(formatOpDate(INSTANT, { timezone: 'UTC', dateFormat: 'iso_24h' }))).toBe('2026-04-01');
        expect(norm(formatOpTime(INSTANT, { timezone: 'UTC', dateFormat: 'iso_24h' }))).toBe('22:05');
        // A preset alone (no zone) still switches to the preset path.
        expect(norm(formatOpDate(LOCAL_MORNING, { dateFormat: 'de_24h' }))).toBe('01 04 26');
        expect(norm(formatOpTime(LOCAL_MORNING, { dateFormat: 'de_24h' }))).toBe('09:05');
    });

    it('with no prefs (or empty prefs) keep the old runtime-locale, runtime-zone rendering', () => {
        for (const prefs of [undefined, {}, { timezone: '', dateFormat: null }]) {
            const dt = norm(formatOpDateTime(LOCAL_MORNING, prefs));
            // Four-digit year (the preset path would print "26"), local wall-clock time.
            expect(dt).toContain('2026');
            expect(dt).toContain('09:05');
            expect(dt).toContain('01');
            expect(dt).not.toMatch(/\b04\b/); // month is a short name, not a number
            const d = norm(formatOpDate(LOCAL_MORNING, prefs));
            expect(d).toContain('2026');
            expect(d).toContain('01');
            expect(d).not.toContain('09:05');
            const t = norm(formatOpTime(LOCAL_MORNING, prefs));
            expect(t).toContain('09:05');
            expect(t).not.toContain('2026');
        }
    });

    it('return an em dash for missing or unparseable input, whatever the prefs', () => {
        for (const bad of [undefined, null, '', 'garbage']) {
            expect(formatOpDateTime(bad)).toBe('—');
            expect(formatOpDate(bad, { timezone: 'UTC' })).toBe('—');
            expect(formatOpTime(bad, { dateFormat: 'iso_24h' })).toBe('—');
        }
    });
});

describe('datetime-local round trip', () => {
    it('toLocalDatetimeValue renders the runtime-zone wall-clock as YYYY-MM-DDTHH:mm, zero-padded', () => {
        expect(toLocalDatetimeValue(new Date(2026, 0, 2, 3, 4).toISOString())).toBe('2026-01-02T03:04');
        expect(toLocalDatetimeValue(new Date(2026, 11, 31, 23, 59, 59).toISOString())).toBe('2026-12-31T23:59');
    });

    it('toLocalDatetimeValue returns "" (safe for a controlled input) for missing/invalid input', () => {
        expect(toLocalDatetimeValue(undefined)).toBe('');
        expect(toLocalDatetimeValue(null)).toBe('');
        expect(toLocalDatetimeValue('nope')).toBe('');
    });

    it('fromLocalDatetimeValue parses the input as local time and returns UTC ISO for storage', () => {
        expect(fromLocalDatetimeValue('2026-01-02T03:04')).toBe(new Date(2026, 0, 2, 3, 4).toISOString());
        // Round trip is lossless at minute precision in any zone.
        expect(fromLocalDatetimeValue(toLocalDatetimeValue(INSTANT))).toBe(INSTANT);
    });

    it('fromLocalDatetimeValue returns null for empty or unparseable input (never "Invalid Date")', () => {
        expect(fromLocalDatetimeValue('')).toBeNull();
        expect(fromLocalDatetimeValue(null)).toBeNull();
        expect(fromLocalDatetimeValue(undefined)).toBeNull();
        expect(fromLocalDatetimeValue('2026-13-45T99:99')).toBeNull();
    });
});

describe('formatRelativeTime', () => {
    const NOW = Date.parse('2026-04-10T12:00:00.000Z');
    const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

    it('walks the just-now / minutes / hours / days ladder in both directions', () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        expect(formatRelativeTime(at(0))).toBe('just now');
        expect(formatRelativeTime(at(-44_999))).toBe('just now');
        expect(formatRelativeTime(at(44_999))).toBe('in a moment');
        expect(formatRelativeTime(at(-45_000))).toBe('0m ago');
        expect(formatRelativeTime(at(-5 * 60_000))).toBe('5m ago');
        expect(formatRelativeTime(at(5 * 60_000))).toBe('in 5m');
        expect(formatRelativeTime(at(-59 * 60_000 - 59_000))).toBe('59m ago');
        expect(formatRelativeTime(at(-60 * 60_000))).toBe('1h ago');
        expect(formatRelativeTime(at(3 * 3_600_000))).toBe('in 3h');
        expect(formatRelativeTime(at(-23 * 3_600_000 - 3_599_000))).toBe('23h ago');
        expect(formatRelativeTime(at(-24 * 3_600_000))).toBe('1d ago');
        expect(formatRelativeTime(at(2 * 86_400_000))).toBe('in 2d');
        expect(formatRelativeTime(at(-29 * 86_400_000))).toBe('29d ago');
    });

    it('past 30 days falls back to an absolute date in the viewer prefs', () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        expect(norm(formatRelativeTime(at(-30 * 86_400_000), { timezone: 'UTC', dateFormat: 'iso_24h' }))).toBe('2026-03-11');
        expect(norm(formatRelativeTime(at(45 * 86_400_000), { timezone: 'UTC' }))).toBe('25 May 26');
    });

    it('returns "" for missing or invalid input', () => {
        expect(formatRelativeTime(undefined)).toBe('');
        expect(formatRelativeTime(null)).toBe('');
        expect(formatRelativeTime('bad')).toBe('');
    });
});

describe('timezone labels', () => {
    it('getUserTimezoneLabel returns the short zone name for an explicit zone', () => {
        expect(getUserTimezoneLabel({ timezone: 'UTC' })).toBe('UTC');
        expect(getUserTimezoneLabel({ timezone: ' Asia/Tokyo ' })).toBe('GMT+9');
    });

    it('getUserTimezoneLabel asks Intl for the runtime zone when no preference is set', () => {
        const ctor = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
            return { formatToParts: () => [{ type: 'hour', value: '9' }, { type: 'timeZoneName', value: 'AEST' }] } as unknown as Intl.DateTimeFormat;
        });
        expect(getUserTimezoneLabel()).toBe('AEST');
        expect(ctor).toHaveBeenCalledWith(undefined, { timeZone: undefined, timeZoneName: 'short' });
    });

    it('getUserTimezoneLabel falls back to the IANA name for an invalid zone', () => {
        expect(getUserTimezoneLabel({ timezone: 'Not/AZone' })).toBe('Not/AZone');
    });

    it('getUserTimezoneLabel falls back to the resolved runtime zone when no short name is produced', () => {
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
            return {
                formatToParts: () => [{ type: 'hour', value: '9' }],
                resolvedOptions: () => ({ timeZone: 'Europe/Berlin' }),
            } as unknown as Intl.DateTimeFormat;
        });
        expect(getUserTimezoneLabel()).toBe('Europe/Berlin');
        // With an explicit zone the IANA name wins over the runtime zone.
        expect(getUserTimezoneLabel({ timezone: 'Asia/Dubai' })).toBe('Asia/Dubai');
    });

    it('getUserTimezoneLabel returns "" when Intl is unusable and no zone was given', () => {
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { throw new RangeError('no Intl'); });
        expect(getUserTimezoneLabel()).toBe('');
    });

    it('formatOpTimeWithZone / formatOpDateTimeWithZone append the zone label', () => {
        expect(norm(formatOpTimeWithZone(INSTANT, { timezone: 'UTC', dateFormat: 'iso_24h' }))).toBe('22:05 UTC');
        expect(norm(formatOpDateTimeWithZone(INSTANT, { timezone: 'Asia/Tokyo', dateFormat: 'iso_24h' }))).toBe('2026-04-02 07:05 GMT+9');
    });

    it('the *WithZone helpers pass the em dash through without a zone suffix', () => {
        expect(formatOpTimeWithZone(null, { timezone: 'UTC' })).toBe('—');
        expect(formatOpDateTimeWithZone('bad', { timezone: 'UTC' })).toBe('—');
    });

    it('the *WithZone helpers omit the suffix when no label can be resolved', () => {
        // No prefs: the time comes from toLocale*String (not the global Intl.DateTimeFormat
        // binding), while the label lookup fails entirely.
        const time = norm(formatOpTime(LOCAL_MORNING));
        const dateTime = norm(formatOpDateTime(LOCAL_MORNING));
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () { throw new RangeError('no Intl'); });
        expect(norm(formatOpTimeWithZone(LOCAL_MORNING))).toBe(time);
        expect(norm(formatOpDateTimeWithZone(LOCAL_MORNING))).toBe(dateTime);
    });
});

describe('preference helpers', () => {
    it('getDateFormatPresets lists the four presets in picker order with labels and examples', () => {
        expect(getDateFormatPresets()).toEqual([
            { key: 'compact_12h', label: 'Compact (DD MMM YY hh:mm AM/PM)', example: '01 Apr 26 10:00 AM' },
            { key: 'iso_24h', label: 'ISO (YYYY-MM-DD HH:mm)', example: '2026-04-01 10:00' },
            { key: 'us_12h', label: 'US (MMM D, YYYY hh:mm AM/PM)', example: 'Apr 1, 2026 10:00 AM' },
            { key: 'de_24h', label: 'German (DD MM YY HH:MM 24h)', example: '01 04 26 10:00' },
        ]);
    });

    it('isValidDateFormat accepts exactly the four preset keys', () => {
        for (const ok of ['compact_12h', 'iso_24h', 'us_12h', 'de_24h']) expect(isValidDateFormat(ok)).toBe(true);
        for (const bad of ['', 'ISO_24H', 'compact', null, undefined, 1, {}]) expect(isValidDateFormat(bad)).toBe(false);
    });

    it('isValidTimezone accepts real IANA zones and rejects garbage (server-side input gate)', () => {
        expect(isValidTimezone('UTC')).toBe(true);
        expect(isValidTimezone('Australia/Brisbane')).toBe(true);
        expect(isValidTimezone('America/Argentina/Buenos_Aires')).toBe(true);
        for (const bad of ['', 'Mars/Olympus', 'UTC; DROP TABLE users', 42, null, undefined, { tz: 'UTC' }]) {
            expect(isValidTimezone(bad)).toBe(false);
        }
    });

    it('detectBrowserTimezone returns the zone Intl resolves', () => {
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
            return { resolvedOptions: () => ({ timeZone: 'Europe/Berlin' }) } as unknown as Intl.DateTimeFormat;
        });
        expect(detectBrowserTimezone()).toBe('Europe/Berlin');
    });

    it('detectBrowserTimezone falls back to UTC when Intl resolves no zone or throws', () => {
        const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function () {
            return { resolvedOptions: () => ({ timeZone: '' }) } as unknown as Intl.DateTimeFormat;
        });
        expect(detectBrowserTimezone()).toBe('UTC');
        spy.mockImplementation(function () { throw new Error('no Intl'); });
        expect(detectBrowserTimezone()).toBe('UTC');
    });

    it('detectBrowserTimezone returns a valid IANA zone on the real runtime', () => {
        expect(isValidTimezone(detectBrowserTimezone())).toBe(true);
    });

    it('getCommonTimezones returns the curated list as a defensive copy', () => {
        const a = getCommonTimezones();
        expect(a).toHaveLength(34);
        expect(a[0]).toEqual({ label: 'UTC', value: 'UTC' });
        expect(a).toContainEqual({ label: 'Brisbane (AEST)', value: 'Australia/Brisbane' });
        expect(a.every(z => isValidTimezone(z.value))).toBe(true);
        a.length = 0;
        expect(getCommonTimezones()).toHaveLength(34);
    });

    describe('getAllTimezones', () => {
        const original = (Intl as unknown as { supportedValuesOf?: unknown }).supportedValuesOf;
        afterEach(() => {
            (Intl as unknown as { supportedValuesOf?: unknown }).supportedValuesOf = original;
        });
        const commonValues = () => getCommonTimezones().map(z => z.value);

        it('returns the full Intl zone list when the runtime supports it', () => {
            const full = ['Africa/Abidjan', 'Europe/London', 'UTC'];
            const fn = vi.fn(() => full);
            (Intl as unknown as { supportedValuesOf: unknown }).supportedValuesOf = fn;
            expect(getAllTimezones()).toBe(full);
            expect(fn).toHaveBeenCalledWith('timeZone');
        });

        it('falls back to the curated zones when supportedValuesOf is missing, empty, or throws', () => {
            (Intl as unknown as { supportedValuesOf?: unknown }).supportedValuesOf = undefined;
            expect(getAllTimezones()).toEqual(commonValues());
            (Intl as unknown as { supportedValuesOf: unknown }).supportedValuesOf = () => [];
            expect(getAllTimezones()).toEqual(commonValues());
            (Intl as unknown as { supportedValuesOf: unknown }).supportedValuesOf = () => 'UTC';
            expect(getAllTimezones()).toEqual(commonValues());
            (Intl as unknown as { supportedValuesOf: unknown }).supportedValuesOf = () => { throw new RangeError('unsupported key'); };
            expect(getAllTimezones()).toEqual(commonValues());
        });
    });
});

describe('formatCountdown', () => {
    const NOW = Date.parse('2026-04-10T12:00:00.000Z');

    it('renders d hh:mm:ss, hh:mm:ss and mm:ss by magnitude, flooring partial seconds', () => {
        expect(formatCountdown(NOW + 2 * 86_400_000 + 4 * 3_600_000 + 13 * 60_000 + 57_000, NOW)).toBe('2d 04:13:57');
        expect(formatCountdown(NOW + 4 * 3_600_000 + 13 * 60_000 + 57_999, NOW)).toBe('04:13:57');
        expect(formatCountdown(NOW + 13 * 60_000 + 7_000, NOW)).toBe('13:07');
        expect(formatCountdown(NOW + 999, NOW)).toBe('00:00');
        expect(formatCountdown(NOW + 86_400_000, NOW)).toBe('1d 00:00:00');
    });

    it('accepts a Date, an ISO string, or epoch millis as the target', () => {
        const target = NOW + 90_000;
        expect(formatCountdown(new Date(target), NOW)).toBe('01:30');
        expect(formatCountdown(new Date(target).toISOString(), NOW)).toBe('01:30');
        expect(formatCountdown(target, NOW)).toBe('01:30');
    });

    it('returns null once the target has passed, and for null/invalid targets', () => {
        expect(formatCountdown(NOW, NOW)).toBeNull();
        expect(formatCountdown(NOW - 1, NOW)).toBeNull();
        expect(formatCountdown(null, NOW)).toBeNull();
        expect(formatCountdown(undefined, NOW)).toBeNull();
        expect(formatCountdown('not a date', NOW)).toBeNull();
        expect(formatCountdown(new Date('x'), NOW)).toBeNull();
    });

    it('defaults `now` to the current clock', () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        expect(formatCountdown(NOW + 61_000)).toBe('01:01');
        vi.setSystemTime(NOW + 61_000);
        expect(formatCountdown(NOW + 61_000)).toBeNull();
    });
});
