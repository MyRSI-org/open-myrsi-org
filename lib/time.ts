/**
 * Centralized time formatting. Every helper here renders UTC-stored timestamps
 * in the viewer's preferred timezone (or the browser's local zone if no
 * preference is set), so an op scheduled from one zone is read correctly
 * from another without confusion.
 *
 * Storage convention: ISO 8601 strings in UTC (Supabase `timestamptz`).
 * Display convention: viewer's local time using one of the named presets in
 * `DATE_FORMAT_PRESETS`. The `compact_12h` preset (default) renders like
 * "01 Apr 26 10:00 AM".
 *
 * Per-user overrides come from `users.timezone` and `users.date_format`.
 * Components should prefer the `useFormatDate()` hook (in AuthContext) which
 * pulls those prefs out of `currentUser` automatically. Server-side / non-React
 * call sites can use `formatUserDateTime(iso, prefs)` directly with explicit
 * prefs.
 */

const pad = (n: number) => n.toString().padStart(2, '0');

function toDate(iso?: string | null): Date | null {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
}

export type DateFormatPreset = 'compact_12h' | 'iso_24h' | 'us_12h' | 'de_24h';

export interface FormatPrefs {
    /** IANA timezone name. Empty/null/undefined falls back to the browser's local zone. */
    timezone?: string | null;
    /** Preset key. Empty/null/undefined falls back to `compact_12h`. */
    dateFormat?: DateFormatPreset | string | null;
}

const DEFAULT_PRESET: DateFormatPreset = 'compact_12h';

const PRESET_ORDER: DateFormatPreset[] = ['compact_12h', 'iso_24h', 'us_12h', 'de_24h'];

const PRESET_META: Record<DateFormatPreset, { label: string; example: string }> = {
    compact_12h: { label: 'Compact (DD MMM YY hh:mm AM/PM)', example: '01 Apr 26 10:00 AM' },
    iso_24h:     { label: 'ISO (YYYY-MM-DD HH:mm)',          example: '2026-04-01 10:00' },
    us_12h:      { label: 'US (MMM D, YYYY hh:mm AM/PM)',    example: 'Apr 1, 2026 10:00 AM' },
    de_24h:      { label: 'German (DD MM YY HH:MM 24h)',     example: '01 04 26 10:00' },
};

function resolvePreset(value?: string | null): DateFormatPreset {
    if (value === 'compact_12h' || value === 'iso_24h' || value === 'us_12h' || value === 'de_24h') return value;
    return DEFAULT_PRESET;
}

/**
 * Resolve a timezone string for use with Intl. Empty/missing/invalid values
 * fall back to `undefined`, which Intl interprets as the runtime's local zone
 * (the browser's zone in the client, server's in Node).
 */
function resolveTimezone(value?: string | null): string | undefined {
    if (!value) return undefined;
    const t = String(value).trim();
    return t.length > 0 ? t : undefined;
}

// ---------------------------------------------------------------------------
// Formatter cache. Building an Intl.DateTimeFormat is non-trivial; with 363
// call sites touching dates in tight render loops, caching by
// (preset|timezone|locale) keeps the cost negligible.
// ---------------------------------------------------------------------------

interface CachedFormatters {
    dateTime: Intl.DateTimeFormat;
    date: Intl.DateTimeFormat;
    time: Intl.DateTimeFormat;
}

const formatterCache = new Map<string, CachedFormatters>();

function buildOptions(preset: DateFormatPreset, timezone: string | undefined, kind: 'dateTime' | 'date' | 'time'): { locale: string | undefined; options: Intl.DateTimeFormatOptions } {
    // For each preset, return:
    //   - locale: undefined for browser default, or 'en-GB' / 'en-US' to force formatting style
    //   - options: Intl options for the requested kind
    switch (preset) {
        case 'compact_12h': {
            // "01 Apr 26 10:00 AM" — 'en-GB' yields day-first ordering with 2-digit year.
            const base: Intl.DateTimeFormatOptions = { timeZone: timezone };
            if (kind === 'dateTime') return { locale: 'en-GB', options: { ...base, day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true } };
            if (kind === 'date')     return { locale: 'en-GB', options: { ...base, day: '2-digit', month: 'short', year: '2-digit' } };
            return                          { locale: 'en-GB', options: { ...base, hour: '2-digit', minute: '2-digit', hour12: true } };
        }
        case 'iso_24h': {
            // "2026-04-01 10:00" — sv-SE renders ISO-like with space separator and 24h time.
            const base: Intl.DateTimeFormatOptions = { timeZone: timezone };
            if (kind === 'dateTime') return { locale: 'sv-SE', options: { ...base, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } };
            if (kind === 'date')     return { locale: 'sv-SE', options: { ...base, year: 'numeric', month: '2-digit', day: '2-digit' } };
            return                          { locale: 'sv-SE', options: { ...base, hour: '2-digit', minute: '2-digit', hour12: false } };
        }
        case 'us_12h': {
            // "Apr 1, 2026 10:00 AM"
            const base: Intl.DateTimeFormatOptions = { timeZone: timezone };
            if (kind === 'dateTime') return { locale: 'en-US', options: { ...base, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true } };
            if (kind === 'date')     return { locale: 'en-US', options: { ...base, month: 'short', day: 'numeric', year: 'numeric' } };
            return                          { locale: 'en-US', options: { ...base, hour: 'numeric', minute: '2-digit', hour12: true } };
        }
        case 'de_24h': {
            // "01 04 26 10:00" — space-separated DD MM YY HH:MM, 24-hour. Per
            // the user-feedback spec: explicit space separators (not the German
            // dot convention) so the format reads as a DTG group rather than a
            // date. Built from numeric parts directly because no locale renders
            // exactly this with Intl alone (en-GB uses '/', sv-SE uses '-', etc).
            const base: Intl.DateTimeFormatOptions = { timeZone: timezone };
            if (kind === 'dateTime') return { locale: 'en-GB', options: { ...base, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } };
            if (kind === 'date')     return { locale: 'en-GB', options: { ...base, day: '2-digit', month: '2-digit', year: '2-digit' } };
            return                          { locale: 'en-GB', options: { ...base, hour: '2-digit', minute: '2-digit', hour12: false } };
        }
    }
}

function getCachedFormatters(preset: DateFormatPreset, timezone: string | undefined): CachedFormatters {
    const key = `${preset}|${timezone ?? ''}`;
    let entry = formatterCache.get(key);
    if (entry) return entry;
    const dt = buildOptions(preset, timezone, 'dateTime');
    const d  = buildOptions(preset, timezone, 'date');
    const t  = buildOptions(preset, timezone, 'time');
    entry = {
        dateTime: new Intl.DateTimeFormat(dt.locale, dt.options),
        date:     new Intl.DateTimeFormat(d.locale, d.options),
        time:     new Intl.DateTimeFormat(t.locale, t.options),
    };
    formatterCache.set(key, entry);
    return entry;
}

// ---------------------------------------------------------------------------
// Public formatters
// ---------------------------------------------------------------------------

// `de_24h` post-processor. en-GB with 2-digit numeric day/month/year renders as
// "01/04/26", but the German DTG spec from user feedback wants space-separated
// "01 04 26". Replacing all `/` with ` ` is safe — none of the other tokens in
// these outputs use `/` as a separator.
function postProcess(out: string, preset: DateFormatPreset): string {
    if (preset === 'de_24h') return out.replace(/\//g, ' ');
    return out;
}

/**
 * Canonical entry point. Renders a UTC ISO timestamp using the viewer's
 * preferred preset and timezone. Fallbacks: browser zone + `compact_12h`.
 * Returns '—' for missing/invalid input.
 */
export function formatUserDateTime(iso?: string | null, prefs?: FormatPrefs): string {
    const d = toDate(iso);
    if (!d) return '—';
    const preset = resolvePreset(prefs?.dateFormat);
    const tz = resolveTimezone(prefs?.timezone);
    return postProcess(getCachedFormatters(preset, tz).dateTime.format(d), preset);
}

/** Date-only variant of `formatUserDateTime`. */
export function formatUserDate(iso?: string | null, prefs?: FormatPrefs): string {
    const d = toDate(iso);
    if (!d) return '—';
    const preset = resolvePreset(prefs?.dateFormat);
    const tz = resolveTimezone(prefs?.timezone);
    return postProcess(getCachedFormatters(preset, tz).date.format(d), preset);
}

/** Time-only variant of `formatUserDateTime`. */
export function formatUserTime(iso?: string | null, prefs?: FormatPrefs): string {
    const d = toDate(iso);
    if (!d) return '—';
    const preset = resolvePreset(prefs?.dateFormat);
    const tz = resolveTimezone(prefs?.timezone);
    return getCachedFormatters(preset, tz).time.format(d);
}

// ---------------------------------------------------------------------------
// Backward-compatible helpers. Existing callers pass no prefs and get the
// previous behaviour (browser zone, hardcoded format). New callers can pass
// prefs to honour user overrides.
// ---------------------------------------------------------------------------

/** "15 Jan 2024, 14:30" in the viewer's zone. Returns '—' if input is falsy/invalid. */
export function formatOpDateTime(iso?: string | null, prefs?: FormatPrefs): string {
    const d = toDate(iso);
    if (!d) return '—';
    if (prefs && (prefs.timezone || prefs.dateFormat)) return formatUserDateTime(iso, prefs);
    return d.toLocaleString(undefined, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

/** "15 Jan 2024" in the viewer's zone. */
export function formatOpDate(iso?: string | null, prefs?: FormatPrefs): string {
    const d = toDate(iso);
    if (!d) return '—';
    if (prefs && (prefs.timezone || prefs.dateFormat)) return formatUserDate(iso, prefs);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "14:30" in the viewer's zone. */
export function formatOpTime(iso?: string | null, prefs?: FormatPrefs): string {
    const d = toDate(iso);
    if (!d) return '—';
    if (prefs && (prefs.timezone || prefs.dateFormat)) return formatUserTime(iso, prefs);
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Convert a UTC ISO timestamp into the `YYYY-MM-DDTHH:mm` string that
 * `<input type="datetime-local">` expects, in the viewer's local zone.
 * Returns '' for missing/invalid input so it's safe to pass straight into
 * controlled input value props.
 *
 * Note: this helper reads the BROWSER's zone via Date methods, not the user's
 * `timezone` preference — datetime-local inputs are always interpreted in the
 * browser's zone, so mixing in a non-browser preference would mis-write the
 * value when the form was submitted.
 */
export function toLocalDatetimeValue(iso?: string | null): string {
    const d = toDate(iso);
    if (!d) return '';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Inverse of `toLocalDatetimeValue`. The browser already parses a
 * datetime-local string as local time, so `new Date(str).toISOString()`
 * gives us UTC for storage. Returns null for empty input.
 */
export function fromLocalDatetimeValue(local: string | null | undefined): string | null {
    if (!local) return null;
    const d = new Date(local);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

/** "in 2h", "3d ago", "just now". */
export function formatRelativeTime(iso?: string | null, prefs?: FormatPrefs): string {
    const d = toDate(iso);
    if (!d) return '';
    const diff = Date.now() - d.getTime();
    const abs = Math.abs(diff);
    const past = diff >= 0;

    const s = Math.floor(abs / 1000);
    if (s < 45) return past ? 'just now' : 'in a moment';
    const m = Math.floor(s / 60);
    if (m < 60) return past ? `${m}m ago` : `in ${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return past ? `${h}h ago` : `in ${h}h`;
    const days = Math.floor(h / 24);
    if (days < 30) return past ? `${days}d ago` : `in ${days}d`;
    return formatOpDate(iso, prefs);
}

/**
 * Short timezone abbreviation for the given zone (or browser's zone if none).
 * "GMT", "PST", etc. Falls back to the IANA name if the abbreviation is
 * unavailable.
 */
export function getUserTimezoneLabel(prefs?: FormatPrefs): string {
    const tz = resolveTimezone(prefs?.timezone);
    try {
        const parts = new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
        const tzPart = parts.find(p => p.type === 'timeZoneName');
        if (tzPart?.value) return tzPart.value;
    } catch { /* ignore */ }
    try {
        return tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
        return '';
    }
}

/** "14:30 GMT" — local time with the viewer's zone abbreviation appended. */
export function formatOpTimeWithZone(iso?: string | null, prefs?: FormatPrefs): string {
    const time = formatOpTime(iso, prefs);
    if (time === '—') return time;
    const zone = getUserTimezoneLabel(prefs);
    return zone ? `${time} ${zone}` : time;
}

/** "15 Jan 2024, 14:30 GMT" */
export function formatOpDateTimeWithZone(iso?: string | null, prefs?: FormatPrefs): string {
    const dt = formatOpDateTime(iso, prefs);
    if (dt === '—') return dt;
    const zone = getUserTimezoneLabel(prefs);
    return zone ? `${dt} ${zone}` : dt;
}

// ---------------------------------------------------------------------------
// Preference helpers — used by the profile UI and validation paths.
// ---------------------------------------------------------------------------

export function getDateFormatPresets(): { key: DateFormatPreset; label: string; example: string }[] {
    return PRESET_ORDER.map(key => ({ key, ...PRESET_META[key] }));
}

export function isValidDateFormat(value: unknown): value is DateFormatPreset {
    return value === 'compact_12h' || value === 'iso_24h' || value === 'us_12h' || value === 'de_24h';
}

/**
 * Returns the IANA zone the browser thinks it's in (e.g. "Europe/London").
 * Used to seed the user's `timezone` preference on first login. Safe to call
 * in non-browser contexts — returns 'UTC' if Intl is unavailable.
 */
export function detectBrowserTimezone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

/**
 * Curated list of the most-used IANA zones, surfaced first in the profile
 * picker. The full set (~400 zones) is available via
 * `Intl.supportedValuesOf('timeZone')` in modern browsers.
 */
const COMMON_ZONES: { label: string; value: string }[] = [
    { label: 'UTC', value: 'UTC' },
    { label: 'London (GMT/BST)', value: 'Europe/London' },
    { label: 'Berlin (CET/CEST)', value: 'Europe/Berlin' },
    { label: 'Paris (CET/CEST)', value: 'Europe/Paris' },
    { label: 'Madrid (CET/CEST)', value: 'Europe/Madrid' },
    { label: 'Amsterdam (CET/CEST)', value: 'Europe/Amsterdam' },
    { label: 'Stockholm (CET/CEST)', value: 'Europe/Stockholm' },
    { label: 'Helsinki (EET/EEST)', value: 'Europe/Helsinki' },
    { label: 'Moscow (MSK)', value: 'Europe/Moscow' },
    { label: 'Dubai (GST)', value: 'Asia/Dubai' },
    { label: 'Karachi (PKT)', value: 'Asia/Karachi' },
    { label: 'Mumbai (IST)', value: 'Asia/Kolkata' },
    { label: 'Bangkok (ICT)', value: 'Asia/Bangkok' },
    { label: 'Singapore (SGT)', value: 'Asia/Singapore' },
    { label: 'Hong Kong (HKT)', value: 'Asia/Hong_Kong' },
    { label: 'Tokyo (JST)', value: 'Asia/Tokyo' },
    { label: 'Seoul (KST)', value: 'Asia/Seoul' },
    { label: 'Sydney (AEST/AEDT)', value: 'Australia/Sydney' },
    { label: 'Melbourne (AEST/AEDT)', value: 'Australia/Melbourne' },
    { label: 'Brisbane (AEST)', value: 'Australia/Brisbane' },
    { label: 'Perth (AWST)', value: 'Australia/Perth' },
    { label: 'Auckland (NZST/NZDT)', value: 'Pacific/Auckland' },
    { label: 'Honolulu (HST)', value: 'Pacific/Honolulu' },
    { label: 'Anchorage (AKST/AKDT)', value: 'America/Anchorage' },
    { label: 'Los Angeles (PT)', value: 'America/Los_Angeles' },
    { label: 'Denver (MT)', value: 'America/Denver' },
    { label: 'Chicago (CT)', value: 'America/Chicago' },
    { label: 'New York (ET)', value: 'America/New_York' },
    { label: 'Toronto (ET)', value: 'America/Toronto' },
    { label: 'São Paulo (BRT)', value: 'America/Sao_Paulo' },
    { label: 'Buenos Aires (ART)', value: 'America/Argentina/Buenos_Aires' },
    { label: 'Mexico City (CT)', value: 'America/Mexico_City' },
    { label: 'Johannesburg (SAST)', value: 'Africa/Johannesburg' },
    { label: 'Cairo (EET)', value: 'Africa/Cairo' },
];

export function getCommonTimezones(): { label: string; value: string }[] {
    return COMMON_ZONES.slice();
}

/**
 * Returns the full IANA zone list when the browser supports
 * `Intl.supportedValuesOf`. Falls back to the curated common list otherwise.
 */
export function getAllTimezones(): string[] {
    try {
        const fn = (Intl as any)?.supportedValuesOf;
        if (typeof fn === 'function') {
            const list: string[] = fn.call(Intl, 'timeZone');
            if (Array.isArray(list) && list.length > 0) return list;
        }
    } catch { /* ignore */ }
    return COMMON_ZONES.map(z => z.value);
}

/** Strict validation. Used server-side to reject garbage from the client. */
export function isValidTimezone(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0) return false;
    try {
        // Constructing a formatter with the zone throws RangeError if invalid.
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

/**
 * Countdown to an instant, at seconds granularity: "2d 04:13:57", "04:13:57",
 * "13:57". Returns null once the target has passed, and for a null target.
 *
 * formatRelativeTime is unusable for this — it collapses everything under 45
 * seconds to "just now", which is precisely the stretch a countdown exists to
 * show. Deliberately clock-agnostic: it takes `now` as an argument so the caller
 * decides the tick rate (useNow), and so this stays a pure function.
 *
 * COSMETIC ONLY. Every ban check re-evaluates expiry against the SERVER clock
 * (lib/db/bans.ts); a client whose clock says its own ban has run out gets no
 * further than the gate.
 */
export function formatCountdown(target: string | number | Date | null | undefined, now: number = Date.now()): string | null {
    if (target == null) return null;
    const end = target instanceof Date ? target.getTime() : new Date(target).getTime();
    if (Number.isNaN(end)) return null;
    const remaining = end - now;
    if (remaining <= 0) return null;

    const totalSeconds = Math.floor(remaining / 1000);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n: number) => String(n).padStart(2, '0');

    if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    return `${pad(minutes)}:${pad(seconds)}`;
}
