import React, { useState, useEffect } from 'react';
import { IntelBulletin, IntelThreatLevel } from '../../../types';
import { useAuth } from '../../../contexts/AuthContext';
import { useMembers } from '../../../contexts/MembersContext';
import { safe } from '../../../lib/safeRender';
import { ACCENTS } from '../../shared/ui/accents';
import { threatAccent, threatIsAlarm } from './intelStyles';

interface BulletinCardProps {
    bulletin: IntelBulletin;
    onDelete?: (id: string) => void;
    isDeleting?: boolean;
    onClick?: (bulletin: IntelBulletin) => void;
}

/**
 * Legacy export kept for `BulletinDetailModal` compatibility. Prefer the
 * shared `threatAccent` / `ACCENTS` system for new code.
 */
export const getThreatStyles = (level: IntelThreatLevel) => {
    switch (level) {
        case IntelThreatLevel.Critical:
            return { border: 'border-red-500', text: 'text-red-500', bg: 'bg-red-950/30', dot: 'bg-red-500', glow: 'shadow-red-900/30', gradient: 'from-red-950/20' };
        case IntelThreatLevel.High:
            return { border: 'border-orange-500', text: 'text-orange-500', bg: 'bg-orange-950/30', dot: 'bg-orange-500', glow: 'shadow-orange-900/30', gradient: 'from-orange-950/20' };
        case IntelThreatLevel.Medium:
            return { border: 'border-amber-500', text: 'text-amber-500', bg: 'bg-amber-950/30', dot: 'bg-amber-500', glow: 'shadow-amber-900/30', gradient: 'from-amber-950/20' };
        case IntelThreatLevel.Low:
            return { border: 'border-sky-500', text: 'text-sky-500', bg: 'bg-sky-950/30', dot: 'bg-sky-500', glow: 'shadow-sky-900/30', gradient: 'from-sky-950/20' };
        default:
            return { border: 'border-slate-600', text: 'text-slate-400', bg: 'bg-slate-900/30', dot: 'bg-slate-500', glow: 'shadow-slate-900/30', gradient: 'from-slate-950/20' };
    }
};

export const formatCountdown = (expiresAt: string, durationMinutes?: number): string => {
    if (durationMinutes === 0) return 'PERMANENT';
    const diff = new Date(expiresAt).getTime() - Date.now();
    if (diff <= 0) return 'EXPIRED';

    const totalSeconds = Math.floor(diff / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
};

export const formatRelativeTime = (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
};

const BulletinCard: React.FC<BulletinCardProps> = ({ bulletin, onDelete, isDeleting, onClick }) => {
    const { currentUser, hasPermission } = useAuth();
    const { securityClearances } = useMembers();

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
    }, [bulletin.expiresAt, bulletin.durationMinutes, isIndefinite]);

    const isFromAlly = !!bulletin.sourceOrganizationId;
    const canDelete = !isFromAlly && (hasPermission('intel:manage') || bulletin.createdById === currentUser?.id);
    const reportMarkers = bulletin.limitingMarkers || [];

    const accentKey = threatAccent(bulletin.threatLevel);
    const a = ACCENTS[accentKey];
    const isAlarm = threatIsAlarm(bulletin.threatLevel);

    if (isExpired) return null;

    const clearanceName = securityClearances.find(c => c.level === bulletin.classificationLevel)?.name || `LEVEL ${bulletin.classificationLevel}`;

    return (
        <div
            onClick={() => onClick?.(bulletin)}
            className={`group relative flex flex-col rounded-xl overflow-hidden border border-white/10 bg-linear-to-br from-slate-900/80 via-slate-900/60 to-slate-950/80 backdrop-blur-xs shadow-lg transition-all duration-300 ${onClick ? 'cursor-pointer hover:border-white/20 hover:shadow-xl' : ''} ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
        >
            <div className={`absolute inset-y-0 left-0 w-1 ${a.dot} ${isAlarm ? 'animate-pulse' : ''}`} aria-hidden />

            <div
                className={`absolute -top-20 -left-10 w-56 h-56 ${a.bg} rounded-full blur-[90px] opacity-0 group-hover:opacity-60 pointer-events-none transition-opacity duration-500`}
                aria-hidden
            />

            <div className="relative pl-4 pr-3 py-3 flex flex-col gap-2.5">
                <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm border font-black text-[9px] uppercase tracking-widest ${a.bg} ${a.border} ${a.text} ${isAlarm ? 'animate-pulse' : ''}`}>
                            <i className={`fa-solid ${isAlarm ? 'fa-triangle-exclamation' : 'fa-shield-halved'}`} aria-hidden />
                            {safe(bulletin.threatLevel)}
                        </span>
                        {bulletin.location && (
                            <span className="inline-flex items-center gap-1 text-[10px] text-slate-400 font-mono">
                                <i className="fa-solid fa-map-pin text-[8px]" aria-hidden />
                                {safe(bulletin.location)}
                            </span>
                        )}
                    </div>

                    {/* Origin pill: Ally / Shared / Live */}
                    <div className="flex items-center gap-1.5 shrink-0">
                        {isFromAlly ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border font-black text-[9px] uppercase tracking-widest bg-emerald-500/10 text-emerald-300 border-emerald-500/30">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                Ally
                            </span>
                        ) : bulletin.sharedWithAllies ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border font-black text-[9px] uppercase tracking-widest bg-slate-900/60 text-slate-400 border-white/10">
                                <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} />
                                Shared
                            </span>
                        ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm border font-black text-[9px] uppercase tracking-widest bg-slate-900/60 text-slate-400 border-white/10">
                                <span className={`w-1.5 h-1.5 rounded-full ${a.dot} animate-pulse`} />
                                Live
                            </span>
                        )}
                    </div>
                </div>

                <div>
                    <h3 className="text-sm font-black text-white uppercase tracking-tight leading-tight">{safe(bulletin.title)}</h3>
                    {isFromAlly && bulletin.sourceOrganizationName && (
                        <div className="flex items-center gap-1.5 mt-1">
                            <i className="fa-solid fa-handshake text-[9px] text-emerald-400" aria-hidden />
                            <span className="text-[9px] font-bold text-emerald-300/80 uppercase tracking-wider">
                                via {safe(bulletin.sourceOrganizationName)}
                            </span>
                        </div>
                    )}
                </div>

                <p className="text-xs text-slate-300 font-mono leading-relaxed line-clamp-3">{safe(bulletin.body)}</p>

                <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-mono">
                    <span className="text-slate-600 uppercase font-black tracking-widest">CLR</span>
                    <span className="px-1.5 py-0.5 rounded-sm bg-slate-900/60 text-slate-300 border border-white/10 uppercase font-black tracking-wider">
                        {clearanceName}
                    </span>
                    {reportMarkers.length > 0 && (
                        <>
                            <span className="text-slate-600 uppercase font-black tracking-widest ml-1">MKR</span>
                            {reportMarkers.map((m) => (
                                <span
                                    key={typeof m?.id === 'number' ? m.id : safe(m?.code)}
                                    className="px-1.5 py-0.5 rounded-sm bg-slate-950/60 text-sky-400 border border-sky-500/20 uppercase font-black tracking-wider"
                                    title={String(safe((m as any)?.name) || safe(m?.code) || '')}
                                >
                                    {safe(m?.code)}
                                </span>
                            ))}
                        </>
                    )}
                </div>
            </div>

            <div className="relative pl-4 pr-3 py-2 bg-slate-950/40 border-t border-white/5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500 uppercase tracking-widest min-w-0">
                    <span className="truncate">{isFromAlly ? safe(bulletin.sourceOrganizationName, 'Allied Org') : safe(bulletin.createdByUser?.name, 'Unknown')}</span>
                    <span className="text-slate-700">·</span>
                    <span className="shrink-0">{formatRelativeTime(bulletin.createdAt)}</span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-[10px] font-black font-mono uppercase tracking-wider ${isIndefinite ? 'text-emerald-400' : a.text}`}>
                        <i className={`fa-solid ${isIndefinite ? 'fa-thumbtack' : 'fa-clock'} mr-1`} aria-hidden />
                        {countdown}
                    </span>
                    {canDelete && onDelete && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onDelete(bulletin.id); }}
                            disabled={isDeleting}
                            title="Delete Bulletin"
                            className="p-1.5 rounded-sm text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                            {isDeleting
                                ? <i className="fa-solid fa-spinner animate-spin text-xs" aria-hidden />
                                : <i className="fa-solid fa-trash-can text-xs" aria-hidden />}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default BulletinCard;
