
import React, { useState, useEffect } from 'react';
import { IntelBulletin } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useMembers } from '../../contexts/MembersContext';
import { getThreatStyles, formatCountdown, formatRelativeTime } from '../views/intel/BulletinCard';
import WindowFrame from '../layout/WindowFrame';
import { safe } from '../../lib/safeRender';

interface BulletinDetailModalProps {
    isOpen: boolean;
    onClose: () => void;
    bulletin: IntelBulletin;
    onDelete?: (id: string) => void;
}

const BulletinDetailModal: React.FC<BulletinDetailModalProps> = ({ isOpen, onClose, bulletin, onDelete }) => {
    const { currentUser, hasPermission } = useAuth();
    const { securityClearances } = useMembers();
    const styles = getThreatStyles(bulletin.threatLevel);
    const isIndefinite = bulletin.durationMinutes === 0;
    const [countdown, setCountdown] = useState(() => formatCountdown(bulletin.expiresAt, bulletin.durationMinutes));
    const [isExpired, setIsExpired] = useState(false);

    useEffect(() => {
        if (isIndefinite) return;
        const interval = setInterval(() => {
            const remaining = formatCountdown(bulletin.expiresAt, bulletin.durationMinutes);
            setCountdown(remaining);
            if (remaining === 'EXPIRED') {
                setIsExpired(true);
                clearInterval(interval);
            }
        }, 1000);
        return () => clearInterval(interval);
    }, [bulletin.expiresAt, isIndefinite, bulletin.durationMinutes]);

    const isFromAlly = !!bulletin.sourceOrganizationId;
    const canDelete = !isFromAlly && (hasPermission('intel:manage') || bulletin.createdById === currentUser?.id);
    const reportMarkers = bulletin.limitingMarkers || [];

    const threatColorMap: Record<string, 'sky' | 'red' | 'amber' | 'green' | 'indigo' | 'slate'> = {
        Critical: 'red',
        High: 'amber',
        Medium: 'amber',
        Low: 'sky',
    };
    const frameColor = threatColorMap[bulletin.threatLevel] || 'slate';

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Intel Bulletin"
            subtitle={`BLT-${bulletin.id.substring(0, 6)}`}
            icon="fa-solid fa-satellite-dish"
            color={frameColor}
            width="max-w-lg"
        >
            <div className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto">
                    {/* Status indicator + Threat Level */}
                    <div className="flex items-start justify-between">
                        <div className="flex items-center gap-2">
                            <span className={`px-2.5 py-1 rounded-sm text-[10px] font-black uppercase tracking-wider border ${styles.border} ${styles.text} bg-black/30`}>
                                {safe(bulletin.threatLevel)}
                            </span>
                            {isExpired && (
                                <span className="px-2 py-0.5 rounded-sm text-[9px] font-black uppercase bg-slate-800 text-slate-400 border border-slate-700">EXPIRED</span>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5">
                            {isFromAlly ? (
                                <>
                                    <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                                    <span className="text-[9px] font-mono text-emerald-400 uppercase font-black">ALLY</span>
                                </>
                            ) : !isFromAlly && bulletin.sharedWithAllies ? (
                                <>
                                    <span className={`w-2 h-2 rounded-full ${styles.dot} animate-pulse`}></span>
                                    <span className="text-[9px] font-mono text-slate-500 uppercase">SHARED</span>
                                </>
                            ) : (
                                <>
                                    <span className={`w-2 h-2 rounded-full ${styles.dot} animate-pulse`}></span>
                                    <span className="text-[9px] font-mono text-slate-500 uppercase">LIVE</span>
                                </>
                            )}
                        </div>
                    </div>

                    {/* Title */}
                    <div>
                        <h3 className="text-lg font-black text-white uppercase tracking-tight leading-tight">{safe(bulletin.title)}</h3>
                        {isFromAlly && bulletin.sourceOrganizationName && (
                            <div className="flex items-center gap-1.5 mt-1.5">
                                <i className="fa-solid fa-handshake text-[10px] text-emerald-500"></i>
                                <span className="text-[10px] font-bold text-emerald-400/80 uppercase tracking-wider">
                                    via {safe(bulletin.sourceOrganizationName)}
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Location */}
                    {bulletin.location && (
                        <div className="bg-slate-950/30 p-3 rounded-lg border border-slate-800/50">
                            <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider mb-1">Location</p>
                            <div className="flex items-center gap-2">
                                <i className="fa-solid fa-map-pin text-xs text-slate-400"></i>
                                <span className="text-sm text-white font-semibold">{safe(bulletin.location)}</span>
                            </div>
                        </div>
                    )}

                    {/* Full Body — no line-clamp */}
                    <div>
                        <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider mb-1.5">Details</p>
                        <p className="text-sm text-slate-300 font-mono leading-relaxed whitespace-pre-wrap bg-slate-950/20 p-3 rounded-lg border border-slate-800/30">
                            {safe(bulletin.body)}
                        </p>
                    </div>

                    {/* Classification + Markers */}
                    <div>
                        <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider mb-1.5">Classification</p>
                        <div className="flex flex-wrap gap-1.5">
                            <span className="px-1.5 py-0.5 rounded-sm text-[9px] font-black uppercase bg-slate-800 text-slate-300 border border-slate-700">
                                {securityClearances.find(c => c.level === bulletin.classificationLevel)?.name || `LEVEL ${bulletin.classificationLevel}`}
                            </span>
                            {reportMarkers.map((m) => (
                                <span key={typeof m?.id === 'number' ? m.id : m?.code} className="px-1.5 py-0.5 rounded-sm text-[9px] font-black uppercase bg-slate-950 text-sky-500 border border-slate-800">
                                    {safe(m?.code)}
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* Details Grid */}
                    <div className="grid grid-cols-2 gap-3">
                        <div className="bg-slate-950/20 p-3 rounded-lg border border-slate-800/30">
                            <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider mb-1">
                                {isFromAlly ? 'Source' : 'Created By'}
                            </p>
                            <span className="text-sm text-white font-semibold">
                                {isFromAlly ? safe(bulletin.sourceOrganizationName, 'Allied Org') : safe(bulletin.createdByUser?.name, 'Unknown')}
                            </span>
                        </div>
                        <div className="bg-slate-950/20 p-3 rounded-lg border border-slate-800/30">
                            <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider mb-1">Posted</p>
                            <span className="text-sm text-slate-300 font-mono">{formatRelativeTime(bulletin.createdAt)}</span>
                        </div>
                    </div>

                    {/* Countdown */}
                    <div className={`p-3 rounded-lg border ${isIndefinite ? 'border-emerald-500/50 bg-emerald-950/20' : `${styles.border} ${styles.bg}`}`}>
                        <p className="text-[10px] uppercase font-black text-slate-500 tracking-wider mb-1">
                            {isIndefinite ? 'Duration' : 'Time Remaining'}
                        </p>
                        <div className="flex items-center gap-2">
                            <i className={`fa-solid ${isIndefinite ? 'fa-thumbtack text-emerald-400' : `fa-clock ${styles.text}`}`}></i>
                            <span className={`text-lg font-black font-mono uppercase tracking-wider ${isIndefinite ? 'text-emerald-400' : styles.text}`}>
                                {countdown}
                            </span>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors">Close</button>
                    {canDelete && onDelete && (
                        <button
                            onClick={() => onDelete(bulletin.id)}
                            className="px-6 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-bold uppercase tracking-wider transition-all shadow-lg shadow-red-900/30"
                        >
                            <i className="fa-solid fa-trash-can mr-2"></i>Delete
                        </button>
                    )}
                </div>
            </div>
        </WindowFrame>
    );
};

export default BulletinDetailModal;
