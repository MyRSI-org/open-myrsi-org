import React from 'react';
import { ServiceRequestStatus, User } from '../../../../types';
import { ACCENTS } from '../../../shared/ui/accents';
import { useFormatDate } from '../../../../contexts/AuthContext';
import { statusAccent, statusLabel, statusIcon, formatDateFull, timeAgo } from './requestStyles';

export interface MissionLogEntry {
    status: ServiceRequestStatus;
    updatedAt: string;
    updatedBy?: User;
    note?: string;
}

interface Props {
    entries: MissionLogEntry[];
    emptyMessage?: string;
}

/**
 * Vertical timeline for the mission log. Each entry shows the actor's avatar
 * overlapped with a status-coloured node, an action line ("Jane → Accepted"),
 * a relative timestamp, and (if present) a note card. Entries fade in with a
 * 40ms stagger on first mount.
 */
export default function MissionLogTimeline({ entries, emptyMessage = 'No log entries found.' }: Props) {
    const fmt = useFormatDate();
    if (!entries || entries.length === 0) {
        return (
            <div className="text-center py-8 text-slate-600 italic text-xs uppercase tracking-widest">
                {emptyMessage}
            </div>
        );
    }

    return (
        <ol className="relative space-y-5">
            <div className="absolute left-[15px] top-2 bottom-2 w-px bg-linear-to-b from-white/5 via-white/10 to-white/5" aria-hidden />

            {entries.map((entry, idx) => {
                const a = ACCENTS[statusAccent(entry.status)];
                const timestamp = formatDateFull(entry.updatedAt, fmt.prefs);
                const rel = timeAgo(entry.updatedAt);

                return (
                    <li
                        key={`${entry.updatedAt}-${entry.status}`}
                        className="relative flex gap-4 animate-fade-in"
                        style={{ animationDelay: `${Math.min(idx * 40, 400)}ms`, animationFillMode: 'backwards' }}
                    >
                        <div className="relative shrink-0 z-10">
                            <div className={`relative w-8 h-8 rounded-full overflow-hidden bg-slate-900 border-2 ${a.border} shadow-lg`}>
                                {entry.updatedBy?.avatarUrl ? (
                                    <img src={entry.updatedBy.avatarUrl} alt="" className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full flex items-center justify-center text-slate-500">
                                        <i className="fa-solid fa-robot text-xs" aria-hidden />
                                    </div>
                                )}
                            </div>
                            <div
                                className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-slate-900 ${a.dot} flex items-center justify-center`}
                                title={statusLabel(entry.status)}
                            >
                                <i className={`fa-solid ${statusIcon(entry.status)} text-[8px] text-white`} aria-hidden />
                            </div>
                        </div>

                        <div className="flex-1 min-w-0 pb-1">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1.5">
                                <span className="text-xs font-black text-white tracking-tight">
                                    {entry.updatedBy?.name || 'System Terminal'}
                                </span>
                                <span className="text-slate-600">→</span>
                                <span className={`text-[10px] font-black uppercase tracking-widest ${a.text}`}>
                                    {statusLabel(entry.status)}
                                </span>
                                <span
                                    className="ml-auto text-[10px] text-slate-500 font-mono tracking-wider"
                                    title={timestamp}
                                >
                                    {rel}
                                </span>
                            </div>
                            {entry.note && (
                                <div className="relative rounded-lg border border-white/5 bg-slate-950/50 px-3 py-2">
                                    <div className={`absolute left-0 top-2 bottom-2 w-0.5 ${a.dot} rounded-full`} aria-hidden />
                                    <p className="text-xs text-slate-300 leading-relaxed italic pl-2">
                                        &ldquo;{entry.note}&rdquo;
                                    </p>
                                </div>
                            )}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
