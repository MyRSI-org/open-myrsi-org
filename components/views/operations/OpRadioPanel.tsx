
import React, { useEffect, useRef } from 'react';
import TXLevelMeter from '../../ui/TXLevelMeter';

export interface OpRadioState {
    isConnected: boolean;
    isConnecting: boolean;
    isTransmitting: boolean;
    activeSpeakers: string[];
    participants: string[];
    error: string | null;
    volume: number;
    setVolume: (vol: number) => void;
    isMuted: boolean;
    toggleMute: () => void;
    handlePTT: (active: boolean) => void;
    connect: () => void;
    disconnect: () => void;
    localAudioLevel: number;
}

interface OpRadioPanelProps {
    radio: OpRadioState;
    compact?: boolean;
}

const OpRadioPanel: React.FC<OpRadioPanelProps> = ({ radio, compact }) => {
    const {
        isConnected, isConnecting, isTransmitting,
        activeSpeakers, participants, error,
        volume, setVolume, isMuted, toggleMute,
        handlePTT, connect, disconnect, localAudioLevel,
    } = radio;

    const pttRef = useRef<HTMLButtonElement>(null);

    // Touch support for PTT
    useEffect(() => {
        const btn = pttRef.current;
        if (!btn) return;
        const onTouchStart = (e: TouchEvent) => { e.preventDefault(); handlePTT(true); };
        const onTouchEnd = (e: TouchEvent) => { e.preventDefault(); handlePTT(false); };
        btn.addEventListener('touchstart', onTouchStart, { passive: false });
        btn.addEventListener('touchend', onTouchEnd, { passive: false });
        return () => {
            btn.removeEventListener('touchstart', onTouchStart);
            btn.removeEventListener('touchend', onTouchEnd);
        };
    }, [handlePTT]);

    return (
        <div className={`bg-slate-950/70 backdrop-blur-md border border-amber-500/20 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.4)] ${compact ? 'p-2.5 space-y-2.5' : 'p-3.5 space-y-3'}`}>
            <div className="flex items-center justify-between border-b border-amber-500/10 pb-2">
                <div className="flex items-center gap-2">
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-sm bg-amber-500/15 border border-amber-500/30">
                        <i className="fa-solid fa-tower-broadcast text-amber-300 text-[11px]" />
                    </span>
                    <span className="text-[10px] font-black text-amber-200 uppercase tracking-[0.2em]">Op Radio</span>
                </div>
                <div className="flex items-center gap-2">
                    {isConnected ? (
                        <span className="flex items-center gap-1.5 text-[10px] font-bold text-green-300 uppercase tracking-widest">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-400 shadow-[0_0_6px_rgba(34,197,94,0.7)] animate-pulse" />
                            Linked
                        </span>
                    ) : isConnecting ? (
                        <span className="text-[10px] font-bold text-amber-300 uppercase tracking-widest animate-pulse">Linking…</span>
                    ) : (
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Offline</span>
                    )}
                    {isConnected && (
                        <button
                            onClick={disconnect}
                            className="px-1.5 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-wider text-red-300 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 transition-colors"
                            title="Disconnect"
                        >
                            <i className="fa-solid fa-power-off" />
                        </button>
                    )}
                </div>
            </div>

            {error && (
                <div className="text-[11px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-sm px-2 py-1">{error}</div>
            )}

            {isConnected && participants.length > 0 && !compact && (
                <div className="flex flex-wrap gap-1">
                    {participants.map((name) => (
                        <span
                            key={name}
                            className={`text-[10px] px-1.5 py-0.5 rounded uppercase font-bold tracking-wide border transition-all ${
                                activeSpeakers.includes(name)
                                    ? 'bg-amber-500/20 text-amber-200 border-amber-500/40 shadow-[0_0_6px_rgba(245,158,11,0.4)]'
                                    : 'bg-slate-800/60 text-slate-400 border-slate-700/50'
                            }`}
                        >
                            {activeSpeakers.includes(name) && <i className="fa-solid fa-microphone mr-1 text-[8px]" />}
                            {name}
                        </span>
                    ))}
                </div>
            )}

            <div className="flex items-center gap-2">
                <button
                    onClick={toggleMute}
                    className={`px-2 py-1 rounded text-xs border transition-colors ${
                        isMuted
                            ? 'text-red-300 bg-red-500/10 border-red-500/30 hover:bg-red-500/20'
                            : 'text-slate-300 bg-slate-800/60 border-slate-700/50 hover:bg-slate-800'
                    }`}
                    title={isMuted ? 'Unmute' : 'Mute'}
                >
                    <i className={`fa-solid ${isMuted ? 'fa-volume-xmark' : 'fa-volume-high'}`} />
                </button>
                <input
                    type="range"
                    min={0}
                    max={100}
                    value={volume}
                    onChange={e => setVolume(Number(e.target.value))}
                    className="flex-1 h-1 accent-amber-500"
                />
                <span className="text-[10px] font-mono text-slate-400 w-9 text-right tabular-nums">{volume}%</span>
            </div>

            <button
                ref={pttRef}
                onMouseDown={() => handlePTT(true)}
                onMouseUp={() => handlePTT(false)}
                onMouseLeave={() => { if (isTransmitting) handlePTT(false); }}
                disabled={!isConnected || isMuted}
                className={`w-full ${compact ? 'py-2' : 'py-3'} rounded-lg font-black text-sm uppercase tracking-[0.2em] transition-all select-none border ${
                    isTransmitting
                        ? 'bg-red-500 text-black border-red-400 shadow-[0_0_18px_rgba(239,68,68,0.55)] scale-[0.98]'
                        : isConnected && !isMuted
                            ? 'bg-amber-500/10 text-amber-300 border-amber-500/30 hover:bg-amber-500/20 active:bg-amber-500 active:text-black'
                            : 'bg-slate-800/40 text-slate-600 border-slate-700/30 cursor-not-allowed'
                }`}
            >
                <i className={`fa-solid ${isTransmitting ? 'fa-microphone' : 'fa-microphone-slash'} mr-2`} />
                {isTransmitting ? 'Transmitting' : 'Push to Talk'}
            </button>

            <TXLevelMeter
                level={localAudioLevel}
                active={isTransmitting}
                label="TX"
                segments={12}
            />

            {!isConnected && !isConnecting && (
                <button
                    onClick={connect}
                    className="w-full py-1.5 text-[11px] font-bold uppercase tracking-widest text-amber-300 bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 rounded-sm transition-colors"
                >
                    <i className="fa-solid fa-rotate-right mr-1" /> Reconnect
                </button>
            )}
        </div>
    );
};

export default OpRadioPanel;
