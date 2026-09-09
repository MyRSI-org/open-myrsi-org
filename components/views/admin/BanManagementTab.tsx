import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useFormatDate } from '../../../contexts/AuthContext';
import { useNotification } from '../../../contexts/NotificationContext';
import { useNow } from '../../../hooks/useNow';
import { formatCountdown } from '../../../lib/time';
import { TabPageHeader, SectionPanel, HeroStat, EmptyState } from '../../shared/ui';
import type { OrgBan, BanAppeal, User } from '../../../types';

// =============================================================================
// Ban management — the staff side of org-level bans
// =============================================================================
// Everything here is behind `admin:user:ban`, gated at the tab registry AND on
// the server (fullPermissionMap in api/services.ts). The whole tab is hidden from
// anyone without it, per the hide-don't-disable rule.
//
// The list is RPC-hydrated. Bans are deliberately in NO /api/query subset and
// emit NO realtime event: an id-only broadcast on the org channel would still
// tell every subscriber that a named member was just banned, which is exactly the
// content a ban is not supposed to publish (security rule 4).

type Panel = 'active' | 'appeals' | 'history' | 'issue';

/** Preset durations. Absent = permanent. */
const DURATIONS: Array<{ label: string; hours: number | null }> = [
    { label: '24 hours', hours: 24 },
    { label: '7 days', hours: 24 * 7 },
    { label: '30 days', hours: 24 * 30 },
    { label: '90 days', hours: 24 * 90 },
    { label: 'Permanent', hours: null },
];

const MAX_REASON = 1000;

/**
 * Sub-view definitions. `label` drives the top tab strip (the same sticky,
 * underlined strip other Admin tabs use); `title`/`note`/`icon` drive the
 * SectionPanel that wraps the active body.
 *
 * `issue` is a panel like any other rather than a form pinned above the lists:
 * placing a ban is a rare, deliberate act, and leaving its form permanently on
 * screen would push the three review lists — the thing staff actually come here
 * for — below the fold on every visit.
 */
const PANELS: Array<{ id: Panel; label: string; icon: string; title: string; note: string }> = [
    { id: 'active', label: 'Active', icon: 'fa-solid fa-user-slash', title: 'Active Bans', note: 'Members currently locked out of this organization.' },
    { id: 'appeals', label: 'Appeals', icon: 'fa-solid fa-scale-balanced', title: 'Pending Appeals', note: 'Statements from banned members awaiting a decision.' },
    { id: 'history', label: 'History', icon: 'fa-solid fa-clock-rotate-left', title: 'Ban History', note: 'Lifted and expired bans, and who is accountable for each one.' },
    { id: 'issue', label: 'Issue', icon: 'fa-solid fa-gavel', title: 'Issue a Ban', note: 'Takes effect on their next request. The reason is shown to the banned member.' },
];

const inputCls = 'w-full bg-slate-950/60 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-rose-500/40 focus:ring-1 focus:ring-rose-500/30 outline-hidden transition-colors';
const labelCls = 'block text-sm font-medium text-slate-300 mb-2';
const ghostBtnCls = 'px-3 py-2 rounded-lg bg-slate-800/60 border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700/60 text-[10px] font-bold uppercase tracking-wider transition-colors disabled:opacity-40';

/** Top-level so it isn't re-created every render (which would remount the tabs). */
const PanelTab: React.FC<{ id: Panel; label: string; icon: string; count?: number; active: boolean; onSelect: (id: Panel) => void }> =
    ({ id, label, icon, count, active, onSelect }) => (
        <button
            onClick={() => onSelect(id)}
            className={`shrink-0 flex items-center gap-2 px-4 py-3 text-[11px] font-black uppercase tracking-widest border-b-2 transition-colors ${active ? 'border-rose-500 text-rose-300' : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
        >
            <i className={`${icon} text-[10px]`} aria-hidden />
            <span>{label}</span>
            {typeof count === 'number' && count > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 text-[10px] font-mono">{count}</span>
            )}
        </button>
    );

/** Small state pill — permanent vs. counting down vs. closed out. */
const StatePill: React.FC<{ tone: 'rose' | 'amber' | 'emerald' | 'slate'; icon: string; children: React.ReactNode }> = ({ tone, icon, children }) => {
    const tones = {
        rose: 'bg-rose-500/10 border-rose-500/30 text-rose-300',
        amber: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
        emerald: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300',
        slate: 'bg-slate-500/10 border-slate-500/30 text-slate-400',
    } as const;
    return (
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wider whitespace-nowrap ${tones[tone]}`}>
            <i className={`fa-solid ${icon}`} aria-hidden />
            {children}
        </span>
    );
};

/** One line of provenance — "who did what, when". Top-level for the same reason PanelTab is. */
const MetaRow: React.FC<{ icon: string; children: React.ReactNode }> = ({ icon, children }) => (
    <div className="flex items-start gap-2 text-[11px] text-slate-500 leading-relaxed">
        <i className={`fa-solid ${icon} mt-[3px] w-3 text-center shrink-0 opacity-70`} aria-hidden />
        <span className="min-w-0 break-words">{children}</span>
    </div>
);

const APPEAL_TONE: Record<BanAppeal['status'], 'amber' | 'emerald' | 'slate'> = {
    pending: 'amber',
    accepted: 'emerald',
    rejected: 'slate',
};
const APPEAL_LABEL: Record<BanAppeal['status'], string> = {
    pending: 'Appeal pending',
    accepted: 'Appeal accepted',
    rejected: 'Appeal declined',
};

const BanManagementTab: React.FC = () => {
    const { allUsers, rpcAction } = useData();
    const { addToast, confirm } = useNotification();
    const fmt = useFormatDate();
    const now = useNow(1000);

    const [panel, setPanel] = useState<Panel>('active');
    const [bans, setBans] = useState<OrgBan[]>([]);
    const [appeals, setAppeals] = useState<BanAppeal[]>([]);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    // Ban form
    const [targetId, setTargetId] = useState<string>('');
    const [reason, setReason] = useState('');
    const [durationIdx, setDurationIdx] = useState(0);

    const ok = (msg: string) => addToast(msg, <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50');
    const fail = (e: unknown, fallback: string) => addToast(fallback, <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e instanceof Error ? e.message : 'Something went wrong.' });

    const userById = useMemo(() => {
        const m = new Map<number, User>();
        for (const u of allUsers || []) m.set(u.id, u);
        return m;
    }, [allUsers]);

    // A ban with no linked user row is anchored on a Discord id alone. That id is
    // deliberately never sent to the client (lib/db/bans.ts BAN_COLS omits it), so
    // it renders as unlinked rather than exposing PII with no on-screen purpose.
    const nameFor = useCallback((userId: number | null) => {
        if (userId == null) return 'Unlinked account';
        return userById.get(userId)?.name || `User #${userId}`;
    }, [userById]);

    // `initial` skips the loading flip: the mount effect must not call setState
    // synchronously (react-hooks/set-state-in-effect), and `loading` already
    // starts true, so the first pass has nothing to set.
    const load = useCallback(async (initial = false) => {
        if (!initial) setLoading(true);
        try {
            // Active bans are fetched SEPARATELY rather than filtered out of one
            // combined page. listBans caps at 200 newest-first, so an org with more
            // than 200 total bans would push older-but-still-active rows off the end
            // and they would vanish from the Active panel — unliftable through this
            // console while still locking someone out.
            const [activeRows, allRows, appealRows] = await Promise.all([
                rpcAction('ban:list', { includeLifted: false, limit: 200 }),
                rpcAction('ban:list', { includeLifted: true, limit: 200 }),
                rpcAction('ban:list_appeals', { limit: 200 }),
            ]);
            const merged = new Map<number, OrgBan>();
            for (const b of [...(Array.isArray(allRows) ? allRows : []), ...(Array.isArray(activeRows) ? activeRows : [])] as OrgBan[]) {
                merged.set(b.id, b);
            }
            setBans([...merged.values()]);
            setAppeals(Array.isArray(appealRows) ? appealRows : []);
        } catch (e) {
            fail(e, 'Could not load bans.');
        } finally {
            setLoading(false);
        }
        // `fail` is a per-render closure over addToast; listing it would re-create
        // `load` every render and re-fire the mount effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rpcAction]);

    // Fetch-on-mount goes through an async IIFE rather than calling `load`
    // directly: every setState it performs then happens in a callback after an
    // await, which is what react-hooks/set-state-in-effect is asking for.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            if (cancelled) return;
            await load(true);
        })();
        return () => { cancelled = true; };
    }, [load]);

    // Cosmetic only — the server re-evaluates expiry against its own clock on
    // every check (lib/db/bans.ts). This just decides which list a row appears in.
    const isActive = useCallback((b: OrgBan) => {
        if (b.liftedAt) return false;
        return !b.expiresAt || new Date(b.expiresAt).getTime() > now;
    }, [now]);

    const activeBans = useMemo(() => bans.filter(isActive), [bans, isActive]);
    const pastBans = useMemo(() => bans.filter(b => !isActive(b)), [bans, isActive]);
    const pendingAppeals = useMemo(() => appeals.filter(a => a.status === 'pending'), [appeals]);

    // The appeal embedded on the ban row is the authoritative one for a history
    // card (same ban_id, one appeal per ban). The separately-fetched appeals list
    // is the fallback for a ban whose embed did not come back — one fetched
    // through the active-only page, say.
    const appealByBanId = useMemo(() => {
        const m = new Map<number, BanAppeal>();
        for (const a of appeals) m.set(a.banId, a);
        return m;
    }, [appeals]);
    const appealFor = useCallback((b: OrgBan) => b.appeal ?? appealByBanId.get(b.id) ?? null, [appealByBanId]);

    // Anyone already actively banned is off the list — re-banning supersedes, and
    // offering it here would just be a confusing no-op.
    const bannableUsers = useMemo(() => {
        const banned = new Set(activeBans.map(b => b.userId).filter((v): v is number => v != null));
        return (allUsers || [])
            .filter(u => !banned.has(u.id))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }, [allUsers, activeBans]);

    const placeBan = async () => {
        const uid = Number(targetId);
        if (!uid || !reason.trim()) return;
        const hours = DURATIONS[durationIdx]?.hours ?? null;
        const target = userById.get(uid);
        const confirmed = await confirm({
            title: `Ban ${target?.name || `user #${uid}`}?`,
            message: hours == null
                ? 'This ban does not expire. They are locked out of the organization until it is lifted, and can see the reason and appeal once.'
                : `They will be locked out for ${DURATIONS[durationIdx].label.toLowerCase()}. They can see the reason and appeal once.`,
            confirmText: 'Ban',
            variant: 'danger',
        });
        if (!confirmed) return;
        setBusy(true);
        try {
            await rpcAction('ban:place', {
                targetUserId: uid,
                reason: reason.trim(),
                expiresAt: hours == null ? null : new Date(Date.now() + hours * 3_600_000).toISOString(),
            });
            ok('Ban placed.');
            setTargetId('');
            setReason('');
            await load();
            // Land the operator on the list the ban they just placed is now in,
            // rather than leaving them staring at a cleared form.
            setPanel('active');
        } catch (e) {
            fail(e, 'Could not place the ban.');
        } finally {
            setBusy(false);
        }
    };

    const lift = async (ban: OrgBan) => {
        const confirmed = await confirm({
            title: `Lift the ban on ${nameFor(ban.userId)}?`,
            message: 'They will be able to sign in again immediately.',
            confirmText: 'Lift ban',
        });
        if (!confirmed) return;
        setBusy(true);
        try {
            await rpcAction('ban:lift', { banId: ban.id });
            ok('Ban lifted.');
            await load();
        } catch (e) {
            fail(e, 'Could not lift the ban.');
        } finally {
            setBusy(false);
        }
    };

    // Accepting an appeal LIFTS the ban. There is no "accept but stay banned" in
    // the UI: it leaves the appellant with an accepted appeal and no change to
    // their access, and records a decision the org never actually acted on. A
    // reviewer who wants the ban to stand declines and it runs its course.
    const review = async (appeal: BanAppeal, verdict: 'accepted' | 'rejected') => {
        const ban = bans.find(b => b.id === appeal.banId);
        const who = nameFor(ban?.userId ?? null);
        const confirmed = await confirm(verdict === 'accepted'
            ? {
                title: `Accept the appeal from ${who}?`,
                message: 'The ban is lifted and they can sign in again immediately.',
                confirmText: 'Accept & lift',
            }
            : {
                title: `Decline the appeal from ${who}?`,
                message: 'The ban stands. They cannot submit another appeal for it.',
                confirmText: 'Decline',
                variant: 'danger',
            });
        if (!confirmed) return;
        setBusy(true);
        try {
            await rpcAction('ban:review_appeal', { appealId: appeal.id, verdict, liftBan: verdict === 'accepted' });
            ok(verdict === 'accepted' ? 'Appeal accepted — ban lifted.' : 'Appeal declined.');
            await load();
        } catch (e) {
            fail(e, 'Could not record the decision.');
        } finally {
            setBusy(false);
        }
    };

    const remaining = (b: OrgBan) => formatCountdown(b.expiresAt, now);

    const activePanel = PANELS.find(p => p.id === panel) ?? PANELS[0];
    const panelCount: Partial<Record<Panel, number>> = {
        active: activeBans.length,
        appeals: pendingAppeals.length,
    };

    // ── Accountability blocks ────────────────────────────────────────────────
    // Plain render functions, not nested components: a component declared inside
    // another remounts on every parent render, and these need nameFor/fmt from
    // this closure.

    /** Who issued the ban, and when. Shown on every card — a ban is always someone's decision. */
    const renderIssuedBy = (b: OrgBan) => (
        <MetaRow icon="fa-gavel">
            Issued by <span className="text-slate-400 font-medium">{b.bannedById != null ? nameFor(b.bannedById) : 'an account that no longer exists'}</span>
            {' · '}
            <span className="font-mono">{fmt(b.bannedAt)}</span>
        </MetaRow>
    );

    /**
     * How the ban ended. `liftedById` is NULL either because the acting account has
     * since been deleted (ON DELETE SET NULL on the FK) or because Database Repair
     * lifted it — the break-glass for a ban on an Admin-role holder, which writes
     * its own lift_reason. Both are named rather than rendered as "lifted by
     * nobody", and the lift note below says which.
     */
    const renderClosedOut = (b: OrgBan) => {
        if (!b.liftedAt) {
            return (
                <MetaRow icon="fa-hourglass-end">
                    Expired <span className="font-mono">{fmt(b.expiresAt)}</span>
                </MetaRow>
            );
        }
        return (
            <MetaRow icon="fa-unlock">
                Lifted by{' '}
                <span className="text-slate-400 font-medium">
                    {b.liftedById != null ? nameFor(b.liftedById) : 'no named account — see the lift note'}
                </span>
                {' · '}
                <span className="font-mono">{fmt(b.liftedAt)}</span>
            </MetaRow>
        );
    };

    /**
     * The appeal, in full. This is the record of what the banned member actually
     * said and who decided on it — the history tab is the only place it survives,
     * so it is rendered here rather than summarised away.
     */
    const renderAppeal = (b: OrgBan) => {
        const appeal = appealFor(b);
        if (!appeal) return null;
        return (
            <div className="mt-3 pt-3 border-t border-white/5 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                    <StatePill tone={APPEAL_TONE[appeal.status]} icon="fa-scale-balanced">{APPEAL_LABEL[appeal.status]}</StatePill>
                    <span className="text-[10px] text-slate-600 font-mono">Submitted {fmt(appeal.createdAt)}</span>
                </div>
                <blockquote className="text-slate-400 text-xs whitespace-pre-wrap break-words leading-relaxed border-l-2 border-slate-700/60 pl-3">
                    {appeal.statement}
                </blockquote>
                {appeal.status !== 'pending' && (
                    <MetaRow icon="fa-user-check">
                        Reviewed by{' '}
                        <span className="text-slate-400 font-medium">
                            {appeal.reviewedById != null ? nameFor(appeal.reviewedById) : 'an account that no longer exists'}
                        </span>
                        {appeal.reviewedAt ? <> · <span className="font-mono">{fmt(appeal.reviewedAt)}</span></> : null}
                    </MetaRow>
                )}
                {appeal.reviewNote && <MetaRow icon="fa-comment">Review note: {appeal.reviewNote}</MetaRow>}
            </div>
        );
    };

    const renderIssueForm = () => (
        <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                    <label htmlFor="ban-target" className={labelCls}>Member</label>
                    <select
                        id="ban-target"
                        value={targetId}
                        onChange={e => setTargetId(e.target.value)}
                        disabled={busy}
                        className={inputCls}
                    >
                        <option value="">Select a member…</option>
                        {bannableUsers.map(u => (
                            <option key={u.id} value={u.id}>{u.name}{u.rsiHandle ? ` (${u.rsiHandle})` : ''}</option>
                        ))}
                    </select>
                </div>
                <div>
                    <label htmlFor="ban-duration" className={labelCls}>Duration</label>
                    <select
                        id="ban-duration"
                        value={durationIdx}
                        onChange={e => setDurationIdx(Number(e.target.value))}
                        disabled={busy}
                        className={inputCls}
                    >
                        {DURATIONS.map((d, i) => <option key={d.label} value={i}>{d.label}</option>)}
                    </select>
                </div>
            </div>
            <div>
                <label htmlFor="ban-reason" className={labelCls}>Reason</label>
                <textarea
                    id="ban-reason"
                    value={reason}
                    onChange={e => setReason(e.target.value.slice(0, MAX_REASON))}
                    rows={3}
                    disabled={busy}
                    placeholder="Explain why this member is being banned."
                    className={`${inputCls} resize-none placeholder:text-slate-600`}
                />
                <p className="text-xs text-slate-500 mt-1 font-mono">{reason.length}/{MAX_REASON}</p>
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-1">
                <p className="text-[10px] text-slate-500 leading-relaxed max-w-lg">
                    Members who can manage bans cannot be banned — you cannot ban someone who could
                    ban you back, and that includes every Admin. Remove the permission from them
                    first. Your name is recorded against the ban.
                </p>
                <button
                    onClick={placeBan}
                    disabled={busy || !targetId || !reason.trim()}
                    className="shrink-0 flex items-center justify-center gap-2 bg-rose-600 hover:bg-rose-500 text-white font-bold px-4 py-2.5 rounded-lg border border-rose-500/40 transition-colors shadow-lg shadow-rose-900/20 text-sm whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
                >
                    <i className="fa-solid fa-user-slash" aria-hidden />
                    Ban Member
                </button>
            </div>
        </div>
    );

    const renderList = () => {
        if (loading) {
            return (
                <div className="flex items-center justify-center py-10">
                    <div className="text-center space-y-3">
                        <i className="fa-solid fa-circle-notch animate-spin text-slate-300 text-2xl" aria-hidden />
                        <p className="text-slate-400 text-xs font-mono uppercase tracking-widest">Loading Bans</p>
                    </div>
                </div>
            );
        }

        if (panel === 'active') {
            if (activeBans.length === 0) {
                return (
                    <EmptyState
                        icon="fa-user-check"
                        heading="Nobody is currently banned"
                        description="Members you ban appear here until the ban expires or is lifted."
                        accent="emerald"
                        compact
                    />
                );
            }
            return (
                <div className="space-y-2">
                    {activeBans.map(b => (
                        <div key={b.id} className="rounded-lg border border-rose-500/20 bg-rose-500/5 p-4 flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-slate-100 font-bold text-sm">{nameFor(b.userId)}</span>
                                    {b.expiresAt
                                        ? <StatePill tone="amber" icon="fa-hourglass-half">{remaining(b) ?? 'expiring'} left</StatePill>
                                        : <StatePill tone="rose" icon="fa-infinity">Permanent</StatePill>}
                                </div>
                                <p className="text-slate-400 text-xs mt-2 break-words leading-relaxed">{b.reason}</p>
                                <div className="mt-2 space-y-1">
                                    {renderIssuedBy(b)}
                                    {b.expiresAt && (
                                        <MetaRow icon="fa-hourglass-end">Expires <span className="font-mono">{fmt(b.expiresAt)}</span></MetaRow>
                                    )}
                                </div>
                                {renderAppeal(b)}
                            </div>
                            <button onClick={() => lift(b)} disabled={busy} className={`shrink-0 ${ghostBtnCls}`}>
                                <i className="fa-solid fa-unlock mr-1.5" aria-hidden />
                                Lift
                            </button>
                        </div>
                    ))}
                </div>
            );
        }

        if (panel === 'appeals') {
            if (pendingAppeals.length === 0) {
                return (
                    <EmptyState
                        icon="fa-scale-balanced"
                        heading="No appeals awaiting review"
                        description="Appeals submitted by banned members land here for a decision."
                        accent="amber"
                        compact
                    />
                );
            }
            return (
                <div className="space-y-2">
                    {pendingAppeals.map(a => {
                        const ban = bans.find(b => b.id === a.banId);
                        return (
                            <div key={a.id} className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-slate-100 font-bold text-sm">{nameFor(ban?.userId ?? null)}</span>
                                    <StatePill tone="amber" icon="fa-clock">Pending</StatePill>
                                    <span className="text-[10px] text-slate-600 font-mono">Submitted {fmt(a.createdAt)}</span>
                                </div>
                                {ban && (
                                    <div className="mt-2 space-y-1">
                                        <MetaRow icon="fa-user-slash">Banned for: <span className="text-slate-400">{ban.reason}</span></MetaRow>
                                        {renderIssuedBy(ban)}
                                    </div>
                                )}
                                <p className="text-slate-300 text-xs mt-3 whitespace-pre-wrap break-words leading-relaxed">{a.statement}</p>
                                <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-white/5">
                                    <button
                                        onClick={() => review(a, 'accepted')}
                                        disabled={busy}
                                        className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 text-white text-[10px] font-bold uppercase tracking-wider transition-colors disabled:opacity-40"
                                    >
                                        <i className="fa-solid fa-check mr-1.5" aria-hidden />
                                        Accept &amp; lift ban
                                    </button>
                                    <button onClick={() => review(a, 'rejected')} disabled={busy} className={`${ghostBtnCls} text-slate-400`}>
                                        Decline
                                    </button>
                                    <span className="text-[10px] text-slate-600 leading-relaxed">
                                        Accepting lifts the ban. Declining leaves it to run its course.
                                    </span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            );
        }

        if (pastBans.length === 0) {
            return (
                <EmptyState
                    icon="fa-clock-rotate-left"
                    heading="No past bans"
                    description="Lifted and expired bans are archived here, with who issued and who lifted each one."
                    compact
                />
            );
        }
        return (
            <div className="space-y-2">
                {pastBans.map(b => (
                    <div key={b.id} className="rounded-lg border border-slate-800/60 bg-slate-950/40 p-4">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                            <span className="text-slate-200 font-bold text-sm">{nameFor(b.userId)}</span>
                            <StatePill tone="slate" icon={b.liftedAt ? 'fa-unlock' : 'fa-hourglass-end'}>
                                {b.liftedAt ? 'Lifted' : 'Expired'}
                            </StatePill>
                        </div>
                        <p className="text-slate-400 text-xs mt-2 break-words leading-relaxed">{b.reason}</p>
                        <div className="mt-3 space-y-1">
                            {renderIssuedBy(b)}
                            {renderClosedOut(b)}
                            {b.liftReason && <MetaRow icon="fa-comment">Lift note: {b.liftReason}</MetaRow>}
                        </div>
                        {renderAppeal(b)}
                    </div>
                ))}
            </div>
        );
    };

    return (
        <div className="flex flex-col min-h-full animate-fade-in">
            {/* Sub-tab bar pinned to the top of the view, matching the other
                multi-panel Admin tabs. */}
            <div className="sticky top-0 z-10 flex items-center gap-1 px-4 md:px-8 pt-4 border-b border-slate-800/60 bg-slate-950/60 backdrop-blur-xs overflow-x-auto scrollbar-none">
                {PANELS.map(p => (
                    <PanelTab
                        key={p.id}
                        id={p.id}
                        label={p.label}
                        icon={p.icon}
                        count={panelCount[p.id]}
                        active={panel === p.id}
                        onSelect={setPanel}
                    />
                ))}
            </div>

            <div className="p-4 md:p-8 space-y-6">
                <TabPageHeader
                    title="Bans"
                    icon="fa-solid fa-user-slash"
                    accent="rose"
                    subtitle="A ban locks a member out of this organization. Their record and history are kept, and lifting restores access."
                    actions={
                        panel === 'issue' ? undefined : (
                            <button onClick={() => void load()} disabled={loading || busy} className={ghostBtnCls}>
                                <i className={`fa-solid fa-rotate mr-1.5 ${loading ? 'animate-spin' : ''}`} aria-hidden />
                                Refresh
                            </button>
                        )
                    }
                />

                <div className="hidden md:grid grid-cols-3 gap-3">
                    <HeroStat icon="fa-user-slash" label="Active Bans" value={activeBans.length} accent="rose" emphasize={activeBans.length > 0} />
                    <HeroStat icon="fa-scale-balanced" label="Pending Appeals" value={pendingAppeals.length} accent="amber" emphasize={pendingAppeals.length > 0} />
                    <HeroStat icon="fa-clock-rotate-left" label="Past Bans" value={pastBans.length} accent="slate" />
                </div>

                <SectionPanel title={activePanel.title} icon={activePanel.icon} note={activePanel.note}>
                    {panel === 'issue' ? renderIssueForm() : renderList()}
                </SectionPanel>
            </div>
        </div>
    );
};

export default BanManagementTab;
