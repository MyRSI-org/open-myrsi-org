import React, { useState } from 'react';
import { User } from '../../../types';
import { ACCENTS, AccentKey } from './accents';

interface Props {
    user: User;
    /** Color theme for the gradient bar, orb glow, avatar ring, and rank chip. Defaults to emerald. */
    accent?: AccentKey;
}

/**
 * Identity panel for a member — avatar, name, RSI handle, rank, duty status,
 * unit, role, tenure. Originally inlined inside HR Hub's overview tab; lifted
 * here so the personnel-side Service Record dossier can reuse the exact same
 * chrome.
 */
export default function MemberIdCard({ user, accent = 'emerald' }: Props) {
    const a = ACCENTS[accent];

    // Tint helpers for the avatar ring + rank chip. Map common AccentKeys to
    // hard-coded color shades because Tailwind's JIT can't compose dynamic
    // class fragments like `border-${color}-500/40`.
    const ring = (() => {
        switch (accent) {
            case 'sky': return 'border-sky-500/40';
            case 'emerald': return 'border-emerald-500/40';
            case 'purple': return 'border-purple-500/40';
            case 'amber': return 'border-amber-500/40';
            case 'rose': return 'border-rose-500/40';
            case 'indigo': return 'border-indigo-500/40';
            case 'cyan': return 'border-cyan-500/40';
            case 'orange': return 'border-orange-500/40';
            case 'red': return 'border-red-500/40';
            case 'slate': return 'border-slate-500/40';
        }
    })();

    const gradientBar = (() => {
        switch (accent) {
            case 'sky': return 'bg-linear-to-r from-sky-500 via-sky-400 to-sky-500';
            case 'emerald': return 'bg-linear-to-r from-emerald-500 via-emerald-400 to-emerald-500';
            case 'purple': return 'bg-linear-to-r from-purple-500 via-purple-400 to-purple-500';
            case 'amber': return 'bg-linear-to-r from-amber-500 via-amber-400 to-amber-500';
            case 'rose': return 'bg-linear-to-r from-rose-500 via-rose-400 to-rose-500';
            case 'indigo': return 'bg-linear-to-r from-indigo-500 via-indigo-400 to-indigo-500';
            case 'cyan': return 'bg-linear-to-r from-cyan-500 via-cyan-400 to-cyan-500';
            case 'orange': return 'bg-linear-to-r from-orange-500 via-orange-400 to-orange-500';
            case 'red': return 'bg-linear-to-r from-red-500 via-red-400 to-red-500';
            case 'slate': return 'bg-linear-to-r from-slate-500 via-slate-400 to-slate-500';
        }
    })();

    // Snapshot "now" once at mount for the display-only "days since" tenure
    // label. The tenure granularity is days/months/years, so a per-render live
    // clock read isn't needed; a mount snapshot is the desired behavior (and
    // keeps render pure).
    const [now] = useState(() => Date.now());

    const tenureStartIso = user.tenureStartDate || user.createdAt;
    const memberSince = tenureStartIso ? new Date(tenureStartIso) : null;
    const tenureDays = memberSince
        ? Math.max(0, Math.floor((now - memberSince.getTime()) / (1000 * 60 * 60 * 24)))
        : null;
    const tenureLabel = tenureDays === null
        ? null
        : tenureDays < 30
            ? `${tenureDays} day${tenureDays !== 1 ? 's' : ''}`
            : tenureDays < 365
                ? `${Math.floor(tenureDays / 30)} mo`
                : `${(tenureDays / 365).toFixed(1)} yr`;

    return (
        <div className="relative bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden shadow-lg">
            <div className={`absolute top-0 left-0 w-full h-1 ${gradientBar}`} />
            <div className={`absolute top-0 right-0 w-48 h-48 ${a.heroOrb} blur-[80px] rounded-full pointer-events-none -translate-y-1/2 translate-x-1/2`} />

            <div className="relative z-10 p-5 flex flex-col items-center text-center">
                <img
                    src={user.avatarUrl}
                    alt={user.name}
                    className={`w-24 h-24 rounded-full border-2 ${ring} shadow-xl object-cover`}
                />
                <h2 className="mt-3 text-lg font-black text-white uppercase tracking-tight leading-tight truncate max-w-full w-full">{user.name}</h2>
                <div className="mt-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm bg-slate-950/40 border border-slate-700 text-[10px] font-mono text-slate-300 max-w-full min-w-0">
                    <i className="fa-solid fa-fingerprint text-slate-500 shrink-0" aria-hidden />
                    <span className="truncate min-w-0">{user.rsiHandle}</span>
                </div>

                <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-sm border text-[10px] font-black uppercase tracking-wider ${a.bg} ${a.border} ${a.text}`}>
                        {user.rank?.name || 'Unranked'}
                    </span>
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-sm border text-[10px] font-black uppercase tracking-wider ${user.isDuty ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'bg-slate-500/10 text-slate-400 border-slate-500/30'}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${user.isDuty ? 'bg-green-400 animate-pulse' : 'bg-slate-500'}`} />
                        {user.isDuty ? 'On Duty' : 'Off Duty'}
                    </span>
                </div>
            </div>

            <div className="relative z-10 border-t border-slate-800/80 divide-y divide-slate-800/80">
                <div className="flex items-center justify-between gap-3 px-5 py-3 min-w-0">
                    <span className="text-[10px] text-slate-500 uppercase tracking-widest font-black shrink-0">Unit</span>
                    <span className="text-sm font-bold text-white truncate min-w-0 text-right">{user.unit?.name || 'Unassigned'}</span>
                </div>
                <div className="flex items-center justify-between gap-3 px-5 py-3 min-w-0">
                    <span className="text-[10px] text-slate-500 uppercase tracking-widest font-black shrink-0">Primary Position</span>
                    <span className="text-sm font-bold text-white truncate min-w-0 text-right">{user.position?.name || 'Unassigned'}</span>
                </div>
                <div className="flex items-center justify-between gap-3 px-5 py-3 min-w-0">
                    <span className="text-[10px] text-slate-500 uppercase tracking-widest font-black shrink-0">System Role</span>
                    <span className="text-sm font-bold text-white truncate min-w-0 text-right">{user.role}</span>
                </div>
                {tenureLabel && (
                    <div className="flex items-center justify-between gap-3 px-5 py-3 min-w-0">
                        <span className="text-[10px] text-slate-500 uppercase tracking-widest font-black shrink-0">Tenure</span>
                        <span className="text-sm font-bold text-white tabular-nums truncate min-w-0 text-right">{tenureLabel}</span>
                    </div>
                )}
            </div>
        </div>
    );
}
