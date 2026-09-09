import React, { useCallback, useEffect, useRef, useState } from 'react';
import apiService from '../../../services/apiService';
import type { SecurityEvent } from '../../../types';

// The security audit trail.
//
// Read-only by design: this screen answers "who tried what, when" and nothing else.
// It fetches through the admin:security:list_events RPC (gated on
// admin:security:view_audit, NOT admin:access) rather than any state subset, so the
// rows — which carry actor IPs — never enter the boot bundle or a realtime slice.
//
// Paging is keyset, not offset: the table is append-only and grows fastest exactly
// when you are reading it (during an incident), so an offset page would re-walk rows
// that new inserts keep shifting.

const PAGE = 50;

/** Denials that usually mean someone is probing rather than fat-fingering a button. */
const NOTABLE = new Set([
    'auth.rate_limited',
    'auth.oauth_state.denied',
    'authz.unmapped_action.denied',
]);

const fmt = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

const EventRow: React.FC<{ ev: SecurityEvent }> = ({ ev }) => {
    const [open, setOpen] = useState(false);
    const hasDetails = ev.details && Object.keys(ev.details).length > 0;
    const notable = NOTABLE.has(ev.event);
    return (
        <>
            <tr className="border-b border-slate-800/60 hover:bg-slate-800/30 align-top">
                <td className="px-3 py-2 whitespace-nowrap text-slate-400 font-mono text-[11px]">{fmt(ev.createdAt)}</td>
                <td className="px-3 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-sm text-[10px] font-black uppercase tracking-wider border ${
                        notable
                            ? 'text-amber-300 bg-amber-500/10 border-amber-500/30'
                            : 'text-slate-300 bg-slate-700/30 border-slate-600/40'
                    }`}>
                        {ev.event}
                    </span>
                </td>
                <td className="px-3 py-2 text-slate-300 font-mono text-[11px] break-all">{ev.action || '—'}</td>
                <td className="px-3 py-2 text-slate-300 text-[11px] whitespace-nowrap">
                    {ev.actorLabel || (ev.actorUserId ? `#${ev.actorUserId}` : 'anonymous')}
                    {ev.actorLabel && ev.actorUserId ? <span className="text-slate-500"> #{ev.actorUserId}</span> : null}
                    {!ev.actorUserId && ev.actorLabel ? <span className="text-slate-500 italic"> (removed)</span> : null}
                </td>
                <td className="px-3 py-2 text-slate-400 font-mono text-[11px] whitespace-nowrap">{ev.actorIp || '—'}</td>
                <td className="px-3 py-2 text-right">
                    {hasDetails ? (
                        <button
                            onClick={() => setOpen(o => !o)}
                            className="text-[10px] font-black uppercase tracking-widest text-sky-400 hover:text-sky-300"
                            aria-expanded={open}
                        >
                            {open ? 'Hide' : 'Details'}
                        </button>
                    ) : null}
                </td>
            </tr>
            {open && hasDetails ? (
                <tr className="border-b border-slate-800/60 bg-slate-900/60">
                    <td colSpan={6} className="px-3 py-2">
                        <pre className="text-[11px] text-slate-300 font-mono whitespace-pre-wrap break-all">
                            {JSON.stringify(ev.details, null, 2)}
                        </pre>
                    </td>
                </tr>
            ) : null}
        </>
    );
};

const SecurityAuditTab: React.FC = () => {
    const [events, setEvents] = useState<SecurityEvent[]>([]);
    const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [eventFilter, setEventFilter] = useState('');
    // Guards against a slow first page landing after a filter change and clobbering it.
    const generationRef = useRef(0);

    const load = useCallback(async (opts: { beforeId?: number | null; append?: boolean } = {}) => {
        const gen = ++generationRef.current;
        setLoading(true);
        setError(null);
        try {
            const res = await apiService.rpc('admin:security:list_events', {
                limit: PAGE,
                beforeId: opts.beforeId ?? undefined,
                event: eventFilter.trim() || undefined,
            }) as { events: SecurityEvent[]; nextBeforeId: number | null };
            if (gen !== generationRef.current) return;
            setEvents(prev => (opts.append ? [...prev, ...(res.events || [])] : (res.events || [])));
            setNextBeforeId(res.nextBeforeId ?? null);
        } catch (e) {
            if (gen !== generationRef.current) return;
            setError(e instanceof Error ? e.message : 'Could not load the security audit trail.');
        } finally {
            if (gen === generationRef.current) setLoading(false);
        }
    }, [eventFilter]);

    // Filter-change / mount fetch. `loading` initialises to true, so this path needs no
    // synchronous setLoading(true): the fetch is inlined so every setState is provably
    // post-await and the set-state-in-effect rule is satisfied with no behaviour change.
    // `load` keeps its leading setLoading(true) for the Refresh button and Load-older,
    // which do want the loading flash. Same shape as AllianceManagementTab.
    useEffect(() => {
        const gen = ++generationRef.current;
        void (async () => {
            try {
                const res = await apiService.rpc('admin:security:list_events', {
                    limit: PAGE,
                    event: eventFilter.trim() || undefined,
                }) as { events: SecurityEvent[]; nextBeforeId: number | null };
                if (gen !== generationRef.current) return;
                setEvents(res.events || []);
                setNextBeforeId(res.nextBeforeId ?? null);
                setError(null);
            } catch (e) {
                if (gen !== generationRef.current) return;
                setError(e instanceof Error ? e.message : 'Could not load the security audit trail.');
            } finally {
                if (gen === generationRef.current) setLoading(false);
            }
        })();
    }, [eventFilter]);

    return (
        <div className="space-y-4">
            <div>
                <h2 className="text-xl font-black text-white tracking-tight">Security Audit Trail</h2>
                <p className="text-sm text-slate-400 mt-1 max-w-3xl">
                    Every refused action, recorded. This is what lets you answer who tried something and
                    when, after the fact — server logs are discarded whenever the app is redeployed.
                    Entries are kept for a year by default and then removed automatically.
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <input
                    value={eventFilter}
                    onChange={(e) => setEventFilter(e.target.value)}
                    placeholder="Filter by event, e.g. authz.permission.denied"
                    className="flex-1 min-w-[16rem] bg-slate-900/70 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:border-sky-500/50 focus:outline-none"
                />
                <button
                    onClick={() => void load()}
                    disabled={loading}
                    className="px-3 py-2 text-[11px] font-black uppercase tracking-widest text-slate-300 bg-slate-900/60 border border-slate-700 rounded-lg hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50"
                >
                    <i className="fa-solid fa-rotate-right mr-2" />Refresh
                </button>
            </div>

            {error ? (
                <div className="border border-rose-500/30 bg-rose-500/10 text-rose-300 rounded-lg px-3 py-2 text-xs">{error}</div>
            ) : null}

            <div className="border border-slate-700/50 rounded-xl overflow-hidden bg-slate-900/40">
                <div className="overflow-x-auto">
                    <table className="w-full text-left">
                        <thead>
                            <tr className="border-b border-slate-700/60 bg-slate-900/70">
                                {['When', 'Event', 'Action', 'Who', 'From', 'actions'].map(h => (
                                    <th key={h} className="px-3 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 whitespace-nowrap">
                                        {h === 'actions' ? '' : h}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {events.map(ev => <EventRow key={ev.id} ev={ev} />)}
                            {!events.length && !loading ? (
                                <tr>
                                    <td colSpan={6} className="px-3 py-8 text-center text-slate-500 text-xs">
                                        No security events recorded.
                                        <span className="block mt-1 text-slate-600">
                                            If you have just updated, re-run schema.sql so the trail can start recording.
                                        </span>
                                    </td>
                                </tr>
                            ) : null}
                        </tbody>
                    </table>
                </div>
                {loading ? <div className="px-3 py-3 text-center text-slate-500 text-xs">Loading…</div> : null}
            </div>

            {nextBeforeId ? (
                <div className="flex justify-center">
                    <button
                        onClick={() => void load({ beforeId: nextBeforeId, append: true })}
                        disabled={loading}
                        className="px-4 py-2 text-[11px] font-black uppercase tracking-widest text-slate-300 bg-slate-900/60 border border-slate-700 rounded-lg hover:border-sky-500/40 hover:text-sky-300 disabled:opacity-50"
                    >
                        Load older
                    </button>
                </div>
            ) : null}
        </div>
    );
};

export default SecurityAuditTab;
