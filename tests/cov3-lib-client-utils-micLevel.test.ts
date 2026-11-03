import { describe, it, expect, vi, afterEach } from 'vitest';
import type { LocalAudioTrack } from 'livekit-client';
import { attachMicLevelMeter } from '../lib/audio/micLevel';

// lib/audio/micLevel.ts — the TX level meter tap used by RadioContext and useOpRadio.
// Web Audio is doubled (jsdom has no AudioContext/MediaStream). Pinned:
//   * every unsupported / failing setup step degrades to `null` (no meter) instead of
//     throwing into the radio context, and a half-built graph closes its AudioContext;
//   * the analyser is a measurement tap only — it is NEVER connected to the destination
//     (that would echo the user's own mic back at them);
//   * getLevel() is RMS of the centred time-domain bytes, scaled x3 and clamped to 1;
//   * dispose() is idempotent, tears the graph down, and swallows teardown failures.

class FakeAnalyser {
    fftSize = 2048;
    smoothingTimeConstant = 0.8;
    fill: (buf: Uint8Array) => void = buf => buf.fill(128);
    getByteTimeDomainData = vi.fn((buf: Uint8Array) => this.fill(buf));
    connect = vi.fn();
    disconnect = vi.fn();
}

class FakeSource {
    connect = vi.fn();
    disconnect = vi.fn();
}

interface Graph {
    ctx: FakeContext | null;
    constructed: number;
    streams: Array<{ tracks: unknown[] }>;
}

class FakeContext {
    static graph: Graph;
    static ctorError: Error | null = null;
    static sourceError: Error | null = null;
    static closeThrowsSync = false;
    analyser = new FakeAnalyser();
    source = new FakeSource();
    destination = { kind: 'destination' };
    createMediaStreamSource = vi.fn((stream: unknown) => {
        if (FakeContext.sourceError) throw FakeContext.sourceError;
        void stream;
        return this.source;
    });
    createAnalyser = vi.fn(() => this.analyser);
    close = vi.fn(() => {
        if (FakeContext.closeThrowsSync) throw new Error('close exploded');
        return Promise.resolve();
    });
    constructor() {
        FakeContext.graph.constructed++;
        if (FakeContext.ctorError) throw FakeContext.ctorError;
        FakeContext.graph.ctx = this;
    }
}

class FakeMediaStream {
    tracks: unknown[];
    constructor(tracks: unknown[]) {
        this.tracks = tracks;
        FakeContext.graph.streams.push(this);
    }
}

function freshGraph(): Graph {
    FakeContext.graph = { ctx: null, constructed: 0, streams: [] };
    FakeContext.ctorError = null;
    FakeContext.sourceError = null;
    FakeContext.closeThrowsSync = false;
    return FakeContext.graph;
}

const mediaStreamTrack = { kind: 'audio', id: 'mic-1' };
const track = (mst: unknown = mediaStreamTrack) => ({ mediaStreamTrack: mst }) as unknown as LocalAudioTrack;

function installWebAudio(which: 'standard' | 'webkit' = 'standard') {
    vi.stubGlobal('MediaStream', FakeMediaStream);
    if (which === 'standard') {
        vi.stubGlobal('AudioContext', FakeContext);
    } else {
        vi.stubGlobal('AudioContext', undefined);
        vi.stubGlobal('webkitAudioContext', FakeContext);
    }
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('attachMicLevelMeter — setup degrades to null', () => {
    it('returns null when the browser has no Web Audio at all', () => {
        const graph = freshGraph();
        vi.stubGlobal('AudioContext', undefined);
        vi.stubGlobal('webkitAudioContext', undefined);
        expect(attachMicLevelMeter(track())).toBeNull();
        expect(graph.constructed).toBe(0);
    });

    it('falls back to the prefixed webkitAudioContext', () => {
        const graph = freshGraph();
        installWebAudio('webkit');
        const meter = attachMicLevelMeter(track());
        expect(meter).not.toBeNull();
        expect(graph.constructed).toBe(1);
    });

    it('returns null without creating a context when the track has no MediaStreamTrack', () => {
        const graph = freshGraph();
        installWebAudio();
        expect(attachMicLevelMeter({} as unknown as LocalAudioTrack)).toBeNull();
        expect(attachMicLevelMeter(track(null))).toBeNull();
        expect(graph.constructed).toBe(0);
    });

    it('returns null when the AudioContext constructor throws (e.g. too many contexts)', () => {
        const graph = freshGraph();
        installWebAudio();
        FakeContext.ctorError = new Error('NotSupportedError');
        expect(attachMicLevelMeter(track())).toBeNull();
        expect(graph.constructed).toBe(1);
    });

    it('closes the half-built context and warns when wiring the graph fails', () => {
        const graph = freshGraph();
        installWebAudio();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const boom = new Error('InvalidStateError');
        FakeContext.sourceError = boom;
        expect(attachMicLevelMeter(track())).toBeNull();
        expect(warn).toHaveBeenCalledWith('[micLevel] failed to attach analyser', boom);
        expect(graph.ctx!.close).toHaveBeenCalledTimes(1);
    });

    it('still returns null when closing the half-built context throws synchronously', () => {
        const graph = freshGraph();
        installWebAudio();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        FakeContext.sourceError = new Error('InvalidStateError');
        FakeContext.closeThrowsSync = true;
        expect(attachMicLevelMeter(track())).toBeNull();
        expect(graph.ctx!.close).toHaveBeenCalledTimes(1);
    });
});

describe('attachMicLevelMeter — graph wiring', () => {
    it('taps the mic track through an analyser and never connects it to the destination', () => {
        const graph = freshGraph();
        installWebAudio();
        attachMicLevelMeter(track());
        const ctx = graph.ctx!;
        expect(graph.streams).toHaveLength(1);
        expect(graph.streams[0].tracks).toEqual([mediaStreamTrack]);
        expect(ctx.createMediaStreamSource).toHaveBeenCalledWith(graph.streams[0]);
        expect(ctx.analyser.fftSize).toBe(512);
        expect(ctx.analyser.smoothingTimeConstant).toBe(0.6);
        expect(ctx.source.connect).toHaveBeenCalledTimes(1);
        expect(ctx.source.connect).toHaveBeenCalledWith(ctx.analyser);
        // Measurement tap only: no analyser → destination edge (no mic echo).
        expect(ctx.analyser.connect).not.toHaveBeenCalled();
    });
});

describe('attachMicLevelMeter — getLevel', () => {
    function meterWith(fill: (buf: Uint8Array) => void) {
        const graph = freshGraph();
        installWebAudio();
        const meter = attachMicLevelMeter(track())!;
        graph.ctx!.analyser.fill = fill;
        return { meter, analyser: graph.ctx!.analyser };
    }

    it('reads a full fftSize-length window of time-domain bytes', () => {
        const { meter, analyser } = meterWith(buf => buf.fill(128));
        meter.getLevel();
        const buf = analyser.getByteTimeDomainData.mock.calls[0][0];
        expect(buf).toBeInstanceOf(Uint8Array);
        expect(buf.length).toBe(512);
    });

    it('is 0 for silence (every byte at the 128 midpoint)', () => {
        const { meter } = meterWith(buf => buf.fill(128));
        expect(meter.getLevel()).toBe(0);
    });

    it('is RMS of the centred samples scaled x3', () => {
        // Constant +16 offset → centred 0.125 → RMS 0.125 → 0.375.
        const { meter } = meterWith(buf => buf.fill(144));
        expect(meter.getLevel()).toBeCloseTo(0.375, 12);
    });

    it('averages over the whole window (mean of squares, not sum)', () => {
        // Half the window at +32 (centred 0.25), half silent: sqrt(0.0625/2) * 3.
        const { meter } = meterWith(buf => { buf.fill(128); buf.fill(160, 0, 256); });
        expect(meter.getLevel()).toBeCloseTo(Math.sqrt(0.0625 / 2) * 3, 12);
    });

    it('treats negative excursions the same as positive ones', () => {
        const { meter } = meterWith(buf => buf.fill(112)); // -16 → centred -0.125
        expect(meter.getLevel()).toBeCloseTo(0.375, 12);
    });

    it('clamps loud input to 1', () => {
        const { meter } = meterWith(buf => { for (let i = 0; i < buf.length; i++) buf[i] = i % 2 ? 255 : 0; });
        expect(meter.getLevel()).toBe(1);
    });

    it('returns 0 instead of throwing when the analyser read fails', () => {
        const { meter, analyser } = meterWith(() => { throw new Error('detached'); });
        expect(meter.getLevel()).toBe(0);
        expect(analyser.getByteTimeDomainData).toHaveBeenCalledTimes(1);
    });
});

describe('attachMicLevelMeter — dispose', () => {
    it('disconnects both nodes and closes the context exactly once', () => {
        const graph = freshGraph();
        installWebAudio();
        const meter = attachMicLevelMeter(track())!;
        const ctx = graph.ctx!;
        meter.dispose();
        meter.dispose();
        expect(ctx.source.disconnect).toHaveBeenCalledTimes(1);
        expect(ctx.analyser.disconnect).toHaveBeenCalledTimes(1);
        expect(ctx.close).toHaveBeenCalledTimes(1);
    });

    it('reports 0 after dispose without touching the torn-down analyser', () => {
        const graph = freshGraph();
        installWebAudio();
        const meter = attachMicLevelMeter(track())!;
        graph.ctx!.analyser.fill = buf => buf.fill(200);
        meter.dispose();
        expect(meter.getLevel()).toBe(0);
        expect(graph.ctx!.analyser.getByteTimeDomainData).not.toHaveBeenCalled();
    });

    it('swallows disconnect throws and a rejecting close()', async () => {
        const graph = freshGraph();
        installWebAudio();
        const meter = attachMicLevelMeter(track())!;
        const ctx = graph.ctx!;
        ctx.source.disconnect.mockImplementation(() => { throw new Error('not connected'); });
        ctx.analyser.disconnect.mockImplementation(() => { throw new Error('not connected'); });
        // dispose() itself must attach the rejection handler: spy on the returned promise's
        // .catch (without it the rejection would be unhandled and vitest fails the run).
        const rejected = Promise.reject(new Error('already closed'));
        const handled = vi.fn(rejected.catch.bind(rejected));
        Object.assign(rejected, { catch: handled });
        ctx.close.mockImplementation(() => rejected);
        expect(() => meter.dispose()).not.toThrow();
        expect(handled).toHaveBeenCalledTimes(1);
        await expect(handled.mock.results[0].value).resolves.toBeUndefined();
        expect(ctx.source.disconnect).toHaveBeenCalledTimes(1);
        expect(ctx.analyser.disconnect).toHaveBeenCalledTimes(1);
        expect(ctx.close).toHaveBeenCalledTimes(1);
    });
});
