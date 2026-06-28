import React, { useEffect, useMemo, useState } from 'react';
import { HydratedOperation, OperationStatus } from '../../../../types';
import { useMembers } from '../../../../contexts/MembersContext';
import { useFormatDate } from '../../../../contexts/AuthContext';
import { ACCENTS } from '../../../shared/ui/accents';
import ResponderStack from '../requests/ResponderStack';
import { useNavigation } from '../../../../contexts/NavigationContext';
import {
    operationStatusAccent,
    operationStatusIcon,
    operationTypeAccent,
    operationTypeIcon,
    clearanceAccent,
    formatScheduledTime,
    timeAgoShort,
    operationCountdown,
} from './operationStyles';

interface Props {
    operation: HydratedOperation;
}

const OperationCard: React.FC<Props> = ({ operation }) => {
    const { viewOperationDetails } = useNavigation();
    const { securityClearances } = useMembers();
    const fmt = useFormatDate();
    // `tick` only exists to force a re-render; the timer below bumps it so the
    // scheduled-start countdown pill stays accurate.
    const [tick, setTick] = useState(0);

    // Live-tick the countdown every 30s so the pill stays accurate.
    useEffect(() => {
        if (!operation.scheduledStart || operation.status !== OperationStatus.Scheduled) return;
        const id = setInterval(() => setTick(t => t + 1), 30_000);
        return () => clearInterval(id);
    }, [operation.scheduledStart, operation.status]);

    const statusA = ACCENTS[operationStatusAccent(operation.status)];
    const typeA = ACCENTS[operationTypeAccent(operation.type)];
    const typeIcon = operationTypeIcon(operation.type);
    const statusIcon = operationStatusIcon(operation.status);

    const opShortId = operation.id.split('-')[1]?.toUpperCase() ?? operation.id.slice(0, 8).toUpperCase();
    const clearance = securityClearances.find(c => c.level === operation.clearanceLevel);
    const clearanceName = clearance?.name || (operation.clearanceLevel > 0 ? `LVL ${operation.clearanceLevel}` : '');
    const clearanceA = operation.clearanceLevel > 0 ? ACCENTS[clearanceAccent(operation.clearanceLevel)] : null;

    const activeParticipants = useMemo(
        () => operation.participants.filter(p => p.timeLeft === null),
        [operation.participants]
    );
    const activeUsers = useMemo(
        () => activeParticipants.map(p => p.user).filter((u): u is NonNullable<typeof u> => !!u),
        [activeParticipants]
    );

    const countdown = operation.scheduledStart && operation.status === OperationStatus.Scheduled
        ? operationCountdown(operation.scheduledStart)
        : null;

    const ownerName = operation.owner?.name || 'Unknown Commander';
    const ownerRank = operation.owner?.rank?.name;
    const ownerAvatar = operation.owner?.avatarUrl;

    // Classified / isSpecial variant.
    if (operation.isSpecial) {
        return (
            <div
                onClick={() => viewOperationDetails(operation)}
                className="group relative flex flex-col h-full rounded-xl overflow-hidden border border-red-600/30 hover:border-red-500/60 bg-slate-950 shadow-lg transition-all duration-300 cursor-pointer hover:shadow-red-900/20"
            >
                <div className="absolute inset-0 opacity-[0.04] bg-[repeating-linear-gradient(45deg,#dc2626,#dc2626_10px,transparent_10px,transparent_20px)] pointer-events-none" aria-hidden />
                <div className="absolute -top-10 -right-10 w-32 h-32 bg-red-600/10 rounded-full blur-[90px] opacity-60 group-hover:opacity-100 transition-opacity" aria-hidden />
                <div className="absolute inset-y-0 left-0 w-1 bg-red-500 animate-pulse" aria-hidden />

                <div className="relative pl-4 pr-4 py-4 grow flex flex-col">
                    <div className="flex justify-between items-start mb-4">
                        <div className="flex flex-col gap-1.5">
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border font-mono text-[10px] uppercase tracking-widest bg-red-500/10 text-red-300 border-red-500/40 w-fit animate-pulse">
                                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                                Classified
                            </span>
                            <span className="text-[9px] text-red-700/80 font-mono font-bold tracking-widest mt-0.5">AUTH CODE REQUIRED</span>
                        </div>
                        <div className="w-9 h-9 flex items-center justify-center rounded-lg border border-red-900/50 bg-red-950/30 text-red-500 group-hover:text-red-300 group-hover:border-red-500/50 transition-colors">
                            <i className="fa-solid fa-user-secret text-sm" aria-hidden />
                        </div>
                    </div>

                    <h3 className="text-lg font-black text-slate-200 group-hover:text-red-100 transition-colors font-mono tracking-tight mb-4 line-clamp-2">
                        {operation.name.toUpperCase()}
                    </h3>

                    <div className="space-y-2 opacity-50 mb-4 select-none">
                        <div className="h-2 bg-slate-800 rounded-xs w-full relative overflow-hidden">
                            <div className="absolute inset-0 bg-slate-700/50 animate-pulse" />
                        </div>
                        <div className="h-2 bg-slate-800 rounded-xs w-5/6 relative overflow-hidden">
                            <div className="absolute inset-0 bg-slate-700/50 animate-pulse delay-75" />
                        </div>
                    </div>

                    <p className="text-[10px] text-red-700 italic border-l-2 border-red-900/50 pl-2 mt-auto">
                        <i className="fa-solid fa-lock mr-1.5" aria-hidden />
                        Operational details encrypted.
                    </p>
                </div>

                <div className="relative pl-4 pr-3 py-2.5 bg-slate-950/60 border-t border-red-900/20 flex justify-between items-center text-[10px] font-mono text-slate-600 uppercase tracking-wider">
                    <span>Origin: [REDACTED]</span>
                    <i className="fa-solid fa-key text-red-600/40 group-hover:text-red-400 transition-colors" aria-hidden />
                </div>
            </div>
        );
    }

    // Standard variant.
    return (
        <div
            onClick={() => viewOperationDetails(operation)}
            className="group relative flex flex-col h-full rounded-xl overflow-hidden border border-white/10 bg-linear-to-br from-slate-900/80 via-slate-900/60 to-slate-950/80 backdrop-blur-xs shadow-lg transition-all duration-300 cursor-pointer hover:border-white/20 hover:shadow-xl"
        >
            <div className={`absolute inset-y-0 left-0 w-1 ${statusA.dot}`} aria-hidden />

            <div
                className={`absolute -top-20 -left-10 w-64 h-64 ${statusA.bg} rounded-full blur-[90px] opacity-0 group-hover:opacity-60 pointer-events-none transition-opacity duration-500`}
                aria-hidden
            />

            <div className="relative pl-4 pr-3 py-3 bg-slate-950/40 border-b border-white/5 flex items-center justify-between gap-3 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-10 h-10 rounded-lg ${typeA.bg} border ${typeA.border} flex items-center justify-center shrink-0`}>
                        <i className={`fa-solid ${typeIcon} ${typeA.text} text-base`} aria-hidden />
                    </div>
                    <div className="min-w-0">
                        <h3 className="font-bold text-sm leading-tight text-white truncate group-hover:text-white transition-colors">
                            {operation.name}
                        </h3>
                        <div className="flex items-center gap-2 mt-0.5">
                            <span className="font-mono text-[10px] text-slate-500 tracking-wider">OP-{opShortId}</span>
                            <span className="text-slate-700">·</span>
                            <span className="text-[10px] text-slate-500 font-mono">
                                <i className="fa-regular fa-clock mr-1" aria-hidden />
                                {timeAgoShort(operation.createdAt)}
                            </span>
                            <span className="text-slate-700">·</span>
                            <span className={`text-[10px] font-black uppercase tracking-widest ${typeA.text}`}>
                                {operation.type}
                            </span>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                    {operation.isJoint && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-sm border font-black text-[9px] uppercase tracking-widest bg-cyan-500/10 text-cyan-300 border-cyan-500/30">
                            <i className="fa-solid fa-handshake" aria-hidden /> Joint
                        </span>
                    )}
                    {countdown && (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm border font-mono font-bold text-[10px] uppercase tracking-wider ${ACCENTS[countdown.accent].bg} ${ACCENTS[countdown.accent].border} ${ACCENTS[countdown.accent].text} ${countdown.isOverdue ? 'animate-pulse' : ''}`}>
                            <i className={`fa-solid ${countdown.isOverdue ? 'fa-triangle-exclamation' : 'fa-clock'}`} aria-hidden />
                            {countdown.label}
                        </span>
                    )}
                    {clearanceA && (
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-sm border font-black text-[9px] uppercase tracking-widest ${clearanceA.bg} ${clearanceA.border} ${clearanceA.text}`}>
                            <i className="fa-solid fa-shield-halved" aria-hidden /> {clearanceName}
                        </span>
                    )}
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border font-black text-[10px] uppercase tracking-wider ${statusA.bg} ${statusA.border} ${statusA.text} ${operation.status === OperationStatus.Active ? 'animate-pulse' : ''}`}>
                        <i className={`fa-solid ${statusIcon}`} aria-hidden />
                        {operation.status}
                    </span>
                </div>
            </div>

            <div className="relative pl-4 pr-4 py-4 grow grid grid-cols-1 md:grid-cols-5 gap-4 min-h-0">
                <div className="md:col-span-2 flex flex-col gap-3 min-w-0">
                    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-slate-950/40 border border-white/5">
                        {ownerAvatar ? (
                            <img
                                src={ownerAvatar}
                                alt=""
                                className="w-10 h-10 rounded-full border-2 border-slate-700 shrink-0 object-cover"
                            />
                        ) : (
                            <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center border-2 border-slate-700 shrink-0">
                                <i className="fa-solid fa-user text-slate-500" aria-hidden />
                            </div>
                        )}
                        <div className="min-w-0 flex-1">
                            <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest">Commander</p>
                            <p className="text-white font-bold text-sm truncate">{ownerName}</p>
                            {ownerRank && (
                                <p className="text-[10px] font-mono text-slate-400 truncate">{ownerRank}</p>
                            )}
                        </div>
                    </div>

                    {/* Prefer the new platform-locations free-text string; fall back
                        to the legacy joined org-locations row for old ops. */}
                    {(operation.unit || operation.locationText || operation.location) && (
                        <div className="space-y-1">
                            {operation.unit && (
                                <div className="flex items-center gap-2 text-[11px] text-slate-300">
                                    <i className="fa-solid fa-sitemap text-indigo-400 shrink-0" aria-hidden />
                                    <span className="truncate">{operation.unit.name}</span>
                                </div>
                            )}
                            {(operation.locationText || operation.location) && (
                                <div className="flex items-center gap-2 text-[11px] text-slate-300">
                                    <i className="fa-solid fa-map-pin text-sky-400 shrink-0" aria-hidden />
                                    <span className="truncate">{operation.locationText || operation.location?.name}</span>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="md:col-span-3 flex flex-col gap-3 min-w-0 md:border-l md:border-white/5 md:pl-4">
                    <div className="grow min-w-0">
                        <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-1">Mission Briefing</p>
                        <p className="text-slate-300 text-sm leading-relaxed italic line-clamp-3">
                            &ldquo;{operation.description}&rdquo;
                        </p>
                    </div>

                    {activeUsers.length > 0 && (
                        <div>
                            <p className="text-[9px] text-slate-500 uppercase font-black tracking-widest mb-2">
                                Team · {activeUsers.length}{operation.maxParticipants ? ` / ${operation.maxParticipants}` : ''}
                            </p>
                            <ResponderStack
                                members={activeUsers}
                                leadId={operation.ownerId}
                            />
                        </div>
                    )}
                </div>
            </div>

            <div className="relative pl-4 pr-4 py-2.5 bg-slate-950/40 border-t border-white/5 flex items-center justify-between gap-2 shrink-0 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                {operation.scheduledStart ? (
                    <span className="inline-flex items-center gap-1.5 text-amber-400/80 min-w-0 truncate">
                        <i className="fa-regular fa-calendar" aria-hidden />
                        <span className="truncate">{formatScheduledTime(operation.scheduledStart, fmt.prefs)}</span>
                    </span>
                ) : <span />}
                <span className="inline-flex items-center gap-3 shrink-0">
                    {operation.liveStatus && operation.status === OperationStatus.Active && (
                        <span className="inline-flex items-center gap-1 text-emerald-300">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            {operation.liveStatus}
                        </span>
                    )}
                    <span className="inline-flex items-center gap-1 text-slate-400">
                        <i className="fa-solid fa-users" aria-hidden />
                        {activeParticipants.length} Active
                    </span>
                </span>
            </div>
        </div>
    );
};

export default React.memo(OperationCard);
