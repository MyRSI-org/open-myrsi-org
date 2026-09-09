import React, { useState } from 'react';
import { useSession } from '../../contexts/SessionContext';
import { useData } from '../../contexts/DataContext';
import { useNow } from '../../hooks/useNow';
import { formatCountdown } from '../../lib/time';
import type { BanNotice } from '../../types';

// =============================================================================
// BannedView — the blocking screen for a member banned from this org
// =============================================================================
// Rendered as an EARLY RETURN in the DashboardApp gate chain, above the
// maintenance block and above `if (!currentUser)`. NOT an overlay: an overlay
// (fixed inset-0 over a mounted dashboard) would leave every context, realtime
// channel and subset fetch running underneath, which is a visual lock rather
// than a boundary. Nothing below this point mounts.
//
// Why it exists at all: a ban that is only a wall is unaccountable. This screen
// is the whole of what the org still owes someone it has locked out — the reason,
// how long, and one chance to contest it.
//
// The two ban-exempt actions are the ONLY things reachable from here, and both
// are dispatcher-scoped to the caller's own id server-side (api/services.ts
// BAN_EXEMPT_ACTIONS). This screen never sees org data: the notice arrives on the
// LOGGED-OUT boot payload, and every /api/query subset is refused.

interface BannedViewProps {
    notice: BanNotice;
    brandingConfig?: { name?: string };
}

const MAX_STATEMENT = 4000;

const BannedView: React.FC<BannedViewProps> = ({ notice, brandingConfig }) => {
    const { logout } = useSession();
    const { rpcAction } = useData();

    // 1s tick, not the 60s default — a countdown that only moves once a minute
    // reads as broken. It runs for the lifetime of a screen the user cannot
    // navigate away from, which is the cost of showing it at all.
    const now = useNow(1000);
    const countdown = formatCountdown(notice.expiresAt, now);

    const [statement, setStatement] = useState('');
    const [appealStatus, setAppealStatus] = useState(notice.appealStatus);
    const [canAppeal, setCanAppeal] = useState(notice.canAppeal);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showAppeal, setShowAppeal] = useState(false);

    const submitAppeal = async () => {
        const text = statement.trim();
        if (!text) return;
        setSubmitting(true);
        setError(null);
        try {
            await rpcAction('ban:submit_appeal', { statement: text });
            setAppealStatus('pending');
            setCanAppeal(false);
            setShowAppeal(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not submit your appeal. Please try again.');
        } finally {
            setSubmitting(false);
        }
    };

    // Permanent when there is no expiry. A temporary ban whose countdown has run
    // out still shows as expiring: the SERVER decides when it actually lapses
    // (lib/db/bans.ts re-evaluates against the server clock on every check), and
    // the next request is what proves it — hence the reload affordance below
    // rather than an automatic transition this screen has no authority to make.
    const isTemporary = !!notice.expiresAt;

    return (
        <div className="fixed inset-0 h-dvh w-screen bg-slate-950 overflow-y-auto z-9999">
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--tw-gradient-stops))] from-rose-950/30 via-slate-950 to-slate-950" />
            <div className="relative z-10 min-h-full flex flex-col items-center justify-center p-6">
                <div className="w-full max-w-xl">

                    <div className="text-center mb-8">
                        <div className="relative mb-6 inline-block">
                            <div className="absolute inset-0 bg-rose-500 blur-3xl opacity-20 rounded-full"></div>
                            <div className="relative z-10 w-20 h-20 rounded-full bg-rose-500/10 border border-rose-500/30 flex items-center justify-center">
                                <i className="fa-solid fa-user-slash text-rose-400 text-3xl" aria-hidden></i>
                            </div>
                        </div>
                        <h1 className="text-2xl font-black text-white tracking-wider uppercase mb-2">
                            Access Revoked
                        </h1>
                        <div className="h-px w-24 mx-auto bg-linear-to-r from-transparent via-rose-500 to-transparent mb-4 opacity-60" />
                        <p className="text-slate-400 text-sm">
                            You have been banned from{' '}
                            <span className="text-slate-200 font-semibold">{brandingConfig?.name || 'this organization'}</span>.
                        </p>
                    </div>

                    <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-5 mb-4">
                        <div className="text-[10px] font-bold text-rose-400/80 uppercase tracking-widest mb-2">Reason</div>
                        {/* Stripped of markup at write time (lib/db/bans.ts sanitizeText) and
                            rendered as text — this screen is not an injection surface. */}
                        <p className="text-slate-200 text-sm leading-relaxed whitespace-pre-wrap break-words">{notice.reason}</p>
                    </div>

                    <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 p-5 mb-6">
                        <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                            {isTemporary ? 'Time remaining' : 'Duration'}
                        </div>
                        {!isTemporary ? (
                            <p className="text-slate-300 text-sm">This ban does not expire.</p>
                        ) : countdown ? (
                            <p className="text-3xl font-black text-white font-mono tracking-wider tabular-nums">{countdown}</p>
                        ) : (
                            <div className="flex flex-wrap items-center gap-3">
                                <p className="text-emerald-300 text-sm">This ban has expired.</p>
                                <button
                                    onClick={() => window.location.reload()}
                                    className="px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-[10px] font-bold uppercase tracking-wider hover:bg-emerald-500/20 transition-colors"
                                >
                                    Reload to sign back in
                                </button>
                            </div>
                        )}
                    </div>

                    {/* ── Appeal ── */}
                    {appealStatus === 'pending' && (
                        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 mb-6 text-center">
                            <p className="text-amber-200 text-sm">Your appeal has been submitted and is awaiting review.</p>
                        </div>
                    )}
                    {appealStatus === 'rejected' && (
                        <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 p-4 mb-6 text-center">
                            <p className="text-slate-400 text-sm">Your appeal was reviewed and declined.</p>
                        </div>
                    )}
                    {appealStatus === 'accepted' && (
                        // Reachable only in the deliberate accept-but-keep-the-ban case:
                        // an accepted appeal normally LIFTS the ban, so this screen would
                        // not be rendering at all.
                        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 mb-6 text-center">
                            <p className="text-emerald-200 text-sm">Your appeal was accepted.</p>
                        </div>
                    )}

                    {canAppeal && !showAppeal && (
                        <button
                            onClick={() => setShowAppeal(true)}
                            className="w-full mb-3 px-4 py-3 rounded-lg border border-slate-600/60 bg-slate-800/60 text-slate-200 text-sm font-bold uppercase tracking-wider hover:bg-slate-800 transition-colors"
                        >
                            Appeal this ban
                        </button>
                    )}

                    {canAppeal && showAppeal && (
                        <div className="rounded-xl border border-slate-700/40 bg-slate-900/40 p-5 mb-3">
                            <label htmlFor="ban-appeal" className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">
                                Your appeal — you may submit one
                            </label>
                            <textarea
                                id="ban-appeal"
                                value={statement}
                                onChange={e => setStatement(e.target.value.slice(0, MAX_STATEMENT))}
                                rows={5}
                                disabled={submitting}
                                placeholder="Explain why this ban should be reconsidered."
                                className="w-full rounded-lg bg-slate-950/60 border border-slate-700/60 p-3 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-hidden focus:border-slate-500 resize-none"
                            />
                            <div className="flex items-center justify-between mt-2">
                                <span className="text-[10px] text-slate-600 font-mono">{statement.length}/{MAX_STATEMENT}</span>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => { setShowAppeal(false); setError(null); }}
                                        disabled={submitting}
                                        className="px-3 py-2 rounded-lg text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-slate-200 transition-colors"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={submitAppeal}
                                        disabled={submitting || !statement.trim()}
                                        className="px-4 py-2 rounded-lg bg-slate-200 text-slate-950 text-xs font-black uppercase tracking-wider disabled:opacity-40 hover:bg-white transition-colors"
                                    >
                                        {submitting ? 'Submitting…' : 'Submit appeal'}
                                    </button>
                                </div>
                            </div>
                            {error && <p className="text-rose-300 text-xs mt-2">{error}</p>}
                        </div>
                    )}

                    <button
                        onClick={logout}
                        className="w-full px-4 py-3 rounded-lg text-slate-500 text-xs font-bold uppercase tracking-widest hover:text-slate-300 transition-colors"
                    >
                        Sign out
                    </button>
                </div>
            </div>
        </div>
    );
};

export default BannedView;
