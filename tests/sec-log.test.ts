// Security regression tests for the lib/log auto-redaction backstop.
//
// The logger's auto-redaction is a defense-in-depth backstop (primary discipline:
// never pass secrets to the logger). These tests cover three ways a credential
// could slip through the JSON line written to stdout/stderr:
//   1. a secret nested deeper than the walk's depth cap,
//   2. a secret embedded inside an Error message/stack string,
//   3. a secret carried as an own-property of a non-plain (class) instance.
//
// Redaction is pure/synchronous (no DB/API); we spy on process.std*.write exactly
// as tests/log.test.ts does.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { log, refreshLogLevel } from '../lib/log';

describe('lib/log redaction backstop (security)', () => {
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let savedLevel: string | undefined;

    beforeEach(() => {
        savedLevel = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = 'debug';
        refreshLogLevel();
        stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
        if (savedLevel === undefined) delete process.env.LOG_LEVEL;
        else process.env.LOG_LEVEL = savedLevel;
        refreshLogLevel();
    });

    // The full serialized line(s) written to a stream this call. We scan the raw
    // text so a leak via any key/value/nesting is caught regardless of shape.
    function writtenTo(spy: ReturnType<typeof vi.spyOn>): string {
        return spy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    }

    it('does not emit a secret nested past the depth cap', () => {
        // Build a chain far deeper than any reasonable redaction cap, with the
        // secret-named key at the very bottom. The walk must not return the
        // remaining subtree verbatim once it bottoms out.
        let node: Record<string, unknown> = { apiKey: 'sk-deep-leak' };
        for (let i = 0; i < 12; i++) node = { nest: node };

        log.info('deep', { root: node });

        const out = writtenTo(stdoutSpy);
        expect(out).not.toContain('sk-deep-leak');
        // A sentinel marks where the walk bottomed out instead of dumping raw data.
        expect(out).toContain('[REDACTED:depth]');
    });

    it('scrubs a credential embedded in an Error message/stack', () => {
        const err = new Error('request failed: Authorization: Bearer sk-err-leak');
        log.error('upstream', { err });

        const out = writtenTo(stderrSpy);
        expect(out).not.toContain('sk-err-leak');
        // The benign part of the message is preserved (only the value is removed).
        expect(out).toContain('request failed');
    });

    it('does not leak a secret own-property of a non-plain (class) instance', () => {
        class Connection {
            host = 'voice.example';
            // Own enumerable property — JSON.stringify would have dumped this.
            botToken = 'bt-instance-leak';
        }
        log.info('conn', { conn: new Connection() });

        const out = writtenTo(stdoutSpy);
        expect(out).not.toContain('bt-instance-leak');
    });

    it('still redacts secret-named keys and keeps benign fields', () => {
        log.info('x', {
            botToken: 'top-secret',
            userId: 7,
            config: { apiKey: 'sk-leak', model: 'gemini' },
        });
        const out = writtenTo(stdoutSpy);
        expect(out).not.toContain('top-secret');
        expect(out).not.toContain('sk-leak');
        expect(out).toContain('"userId":7');
        expect(out).toContain('gemini');
    });
});
