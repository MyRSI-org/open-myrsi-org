import React, { useEffect, useState } from 'react';
import { useAuth, useFormatDate } from '../../../../contexts/AuthContext';
import { useData } from '../../../../contexts/DataContext';
import { CallsignChip } from '../../../shared/ui';
import { getUserTimezoneLabel } from '../../../../lib/time';

interface Props {
    /** Client path shows reputation; staff path shows rank/unit + duty toggle */
    variant: 'staff' | 'client';
}

export default function DashboardHero({ variant }: Props) {
    const { currentUser, toggleDutyStatus } = useAuth();
    const fmt = useFormatDate();
    const { isFetching } = useData();
    const [now, setNow] = useState(() => new Date());
    const [toggling, setToggling] = useState(false);

    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 60_000);
        return () => clearInterval(id);
    }, []);

    if (!currentUser) return null;

    const greeting = (() => {
        const h = now.getHours();
        if (h < 12) return 'Good Morning';
        if (h < 18) return 'Good Afternoon';
        return 'Good Evening';
    })();

    const firstName = currentUser.name.split(' ')[0];
    const isSyncing = Object.values(isFetching).some(Boolean);
    const isDuty = !!currentUser.isDuty;

    // Render in the viewer's preferred zone & format so ops scheduled across
    // timezones don't confuse crews. Zone abbreviation makes it explicit.
    const nowIso = now.toISOString();
    const timeLabel = fmt.time(nowIso);
    const dateLabel = fmt.date(nowIso).toUpperCase();
    const zoneLabel = getUserTimezoneLabel(fmt.prefs);

    const callsignLabel = variant === 'client'
        ? 'Dashboard · Client'
        : 'Dashboard · Live';

    const handleToggleDuty = async () => {
        if (toggling) return;
        setToggling(true);
        try { await toggleDutyStatus(currentUser.id); } finally { setToggling(false); }
    };

    return (
        <div className="relative rounded-xl border border-white/10 bg-slate-900 overflow-hidden">
            <div className="relative p-5 lg:p-6 bg-linear-to-br from-sky-500/10 via-slate-900 to-slate-900">
                <div
                    className="absolute inset-0 opacity-[0.05] pointer-events-none"
                    aria-hidden
                    style={{
                        backgroundImage:
                            'linear-gradient(to right, rgba(148,163,184,0.4) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.4) 1px, transparent 1px)',
                        backgroundSize: '40px 40px',
                    }}
                />
                <div className="relative flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div className="min-w-0">
                        <CallsignChip label={callsignLabel} accent="sky" pulse className="mb-2" />
                        <h1 className="text-2xl md:text-3xl font-black text-white tracking-tight truncate">
                            <span className="text-slate-400 font-normal mr-2">{greeting},</span>
                            <span className="text-sky-300">{firstName}</span>
                        </h1>
                        <div className="mt-1 flex items-center gap-2 text-[11px] font-mono uppercase tracking-widest text-slate-500">
                            {variant === 'client' ? (
                                <span>Reputation Standing · <span className="text-sky-300">{currentUser.reputation}</span></span>
                            ) : (
                                <span>
                                    {currentUser.rank?.name || 'Operative'}
                                    <span className="text-slate-700 mx-1.5">·</span>
                                    {currentUser.unit?.name || 'General Pool'}
                                </span>
                            )}
                            {isSyncing && (
                                <span className="ml-2 inline-flex items-center gap-1.5 text-sky-400">
                                    <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
                                    Syncing
                                </span>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right">
                            <div className="text-2xl md:text-3xl font-mono font-black text-slate-400 tabular-nums">
                                {timeLabel}
                                {zoneLabel && <span className="ml-1 text-[10px] font-bold text-slate-600 uppercase tracking-widest">{zoneLabel}</span>}
                            </div>
                            <div className="text-[10px] text-slate-500 font-mono uppercase tracking-[0.25em] mt-0.5">
                                {dateLabel}
                            </div>
                        </div>

                        {variant === 'staff' && (
                            <button
                                onClick={handleToggleDuty}
                                disabled={toggling}
                                className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold uppercase tracking-widest transition-colors ${
                                    isDuty
                                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15'
                                        : 'border-white/10 bg-slate-800/60 text-slate-400 hover:text-white hover:bg-white/5'
                                }`}
                                title={isDuty ? 'Go off duty' : 'Go on duty'}
                            >
                                <span className={`w-1.5 h-1.5 rounded-full ${isDuty ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`} />
                                {toggling ? '…' : isDuty ? 'On Duty' : 'Off Duty'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
