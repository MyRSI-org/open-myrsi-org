import { describe, it, expect } from 'vitest';
import { counts404TowardAbuse, isLoopbackIp } from '../lib/abuseFilter';

// Ordinary browser/asset 404s must not count toward the per-IP abuse block (an
// office behind one IP would otherwise lock itself out), while probe-like 404s still
// count so scanners are caught.
describe('counts404TowardAbuse', () => {
    it('does NOT count common browser auto-requested asset 404s', () => {
        for (const p of ['/favicon.ico', '/apple-touch-icon.png', '/apple-touch-icon-180x180.png', '/robots.txt', '/sitemap.xml', '/manifest.webmanifest', '/sw.js']) {
            expect(counts404TowardAbuse('GET', p), p).toBe(false);
        }
    });
    it('does NOT count hashed /assets/* chunk 404s (stale chunks during a deploy)', () => {
        expect(counts404TowardAbuse('GET', '/assets/index-AbC123.js')).toBe(false);
        expect(counts404TowardAbuse('GET', '/assets/vendor-9f8e.css')).toBe(false);
    });
    it('DOES count probe-like unknown GET paths (wordlist scanners)', () => {
        for (const p of ['/wp-login.php', '/admin', '/api/secret', '/.git/config', '/phpinfo.php']) {
            expect(counts404TowardAbuse('GET', p), p).toBe(true);
        }
    });
    it('DOES count any non-GET/HEAD 404 (suspicious by method)', () => {
        expect(counts404TowardAbuse('POST', '/favicon.ico')).toBe(true);
        expect(counts404TowardAbuse('DELETE', '/assets/x.js')).toBe(true);
        expect(counts404TowardAbuse('PUT', '/anything')).toBe(true);
    });
    it('treats HEAD like GET for benign assets', () => {
        expect(counts404TowardAbuse('HEAD', '/favicon.ico')).toBe(false);
        expect(counts404TowardAbuse('HEAD', '/wp-login.php')).toBe(true);
    });
});

describe('isLoopbackIp', () => {
    it('matches loopback addresses (never blackholed — covers a same-host proxy)', () => {
        for (const ip of ['127.0.0.1', '127.0.0.5', '::1', '::ffff:127.0.0.1']) {
            expect(isLoopbackIp(ip), ip).toBe(true);
        }
    });
    it('does not match real client / private / mapped-public IPs', () => {
        for (const ip of ['203.0.113.7', '10.0.0.4', '192.168.1.9', '::ffff:203.0.113.7', 'unknown']) {
            expect(isLoopbackIp(ip), ip).toBe(false);
        }
    });
});
