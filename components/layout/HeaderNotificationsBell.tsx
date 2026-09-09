import React, { useEffect, useRef, useState } from 'react';

import { useData } from '../../contexts/DataContext';
import { useIntel } from '../../contexts/IntelContext';
import { useActionRequired, ActionItem, ActionItemAccent } from '../../hooks/useActionRequired';
import { usePersistentNotifications } from '../../contexts/PersistentNotificationsContext';
import { PersistentNotification } from '../../types';
import { ACCENTS } from '../shared/ui/accents';
import { useNavigation } from '../../contexts/NavigationContext';

const SAFE_ACCENT: Record<ActionItemAccent, keyof typeof ACCENTS> = {
    amber: 'amber',
    rose: 'rose',
    sky: 'sky',
    purple: 'purple',
    emerald: 'emerald',
    indigo: 'indigo',
};

// type → icon for a persistent notification row (falls back to the bell).
const TYPE_ICON: Record<string, string> = {
    request: 'fa-clipboard-list',
    responder: 'fa-user-plus',
    qm_issuance: 'fa-box-open',
    hr_assignment: 'fa-user-check',
    academy_enrolled: 'fa-graduation-cap',
    academy_enrollment_requested: 'fa-hand',
    academy_enrollment_denied: 'fa-hand-back-fist',
    academy_completed: 'fa-award',
    academy_recommended: 'fa-user-graduate',
    academy_course_approved: 'fa-circle-check',
    academy_course_rejected: 'fa-rotate-left',
    operation_assigned: 'fa-crosshairs',
    operation_removed: 'fa-user-minus',
    finance_confirmed: 'fa-circle-check',
    finance_rejected: 'fa-circle-xmark',
    ban_appeal: 'fa-gavel',
    blueprint_request: 'fa-scroll',
};

function relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return `${Math.floor(days / 7)}w ago`;
}

export default function HeaderNotificationsBell() {
    const { items, count, criticalCount } = useActionRequired();
    const { notifications, unreadCount, markRead, markAllRead } = usePersistentNotifications();
    const { setActiveView, viewRequestDetails, setSelectedBulletin } = useNavigation();
    const { hydratedServiceRequests } = useData();
    const { activeBulletins } = useIntel();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    // Badge = unread persistent notifications + live "attention required" items.
    const totalCount = unreadCount + count;

    const handleActionClick = (item: ActionItem) => {
        setOpen(false);
        if (item.type === 'intel' && item.targetId) {
            const bulletin = Array.isArray(activeBulletins)
                ? (activeBulletins as any[]).find((b: any) => String(b.id) === item.targetId)
                : null;
            if (bulletin) {
                setSelectedBulletin(bulletin);
                return;
            }
        }
        if (item.type === 'request' && item.targetId) {
            const req = (hydratedServiceRequests as any[]).find((r) => r.id === item.targetId);
            if (req) {
                viewRequestDetails(req);
                return;
            }
        }
        // Sub-tab deep links — match the localStorage + custom-event pattern each
        // section already listens for. Setting both ensures the tab is applied
        // whether the section view is mounting fresh or already mounted.
        if (item.targetTab) {
            if (item.targetView === 'hr') {
                localStorage.setItem('hr_active_tab', item.targetTab);
                window.dispatchEvent(new CustomEvent('app:navigate-hr-tab', { detail: item.targetTab }));
            }
        }
        setActiveView(item.targetView as any);
    };

    const handleNotificationClick = (n: PersistentNotification) => {
        setOpen(false);
        if (!n.readAt) void markRead([n.id]);
        // `link` is an in-app view target (e.g. 'requests'); coarse section nav.
        if (n.link) setActiveView(n.link as any);
    };

    const accentCls = totalCount === 0
        ? 'text-slate-500 hover:bg-white/5 hover:text-slate-300'
        : criticalCount > 0
            ? 'text-rose-400 hover:bg-rose-500/5'
            : 'text-amber-400 hover:bg-amber-500/5';

    return (
        <div className="relative h-full" ref={ref}>
            <button
                onClick={() => setOpen((v) => !v)}
                className={`relative flex items-center gap-3 px-5 h-full border-l border-white/5 transition-all duration-200 ${accentCls}`}
                aria-label="Notifications"
            >
                <div className="relative">
                    <i className={`fa-solid fa-bell text-lg ${criticalCount > 0 ? 'animate-pulse' : ''}`} />
                    {totalCount > 0 && (
                        <span className={`absolute -top-1.5 -right-1.5 text-white text-[9px] font-black px-1 rounded-xs shadow-xs leading-none min-w-[14px] h-[14px] flex items-center justify-center ${criticalCount > 0 ? 'bg-rose-500' : 'bg-amber-500'}`}>
                            {totalCount > 99 ? '99+' : totalCount}
                        </span>
                    )}
                </div>
                <span className="text-xs font-bold uppercase tracking-wide hidden md:block">Alerts</span>
            </button>

            {open && (
                <div className="absolute top-full right-0 mt-1 w-80 max-w-[calc(100vw-1rem)] bg-slate-900 border border-white/10 rounded-xl shadow-2xl shadow-black/60 z-50 overflow-hidden animate-fade-in">
                    <div className="px-4 py-3 border-b border-white/5 bg-slate-950/50 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="text-[10px] font-mono uppercase tracking-widest text-slate-500">Notifications</p>
                            <p className="text-sm font-bold text-white">
                                {totalCount === 0 ? 'All clear' : `${totalCount} ${totalCount === 1 ? 'item' : 'items'}`}
                                {criticalCount > 0 && <span className="ml-2 text-rose-300">· {criticalCount} critical</span>}
                            </p>
                        </div>
                        {unreadCount > 0 && (
                            <button
                                onClick={() => void markAllRead()}
                                className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-sky-300 px-2 py-1 rounded border border-slate-700 hover:border-sky-500/40 transition-colors"
                            >
                                Mark all read
                            </button>
                        )}
                    </div>

                    {notifications.length === 0 && count === 0 ? (
                        <div className="px-4 py-8 text-center">
                            <i className="fa-solid fa-check-circle text-2xl text-slate-600 mb-2" />
                            <p className="text-xs text-slate-500">You're all caught up.</p>
                        </div>
                    ) : (
                        <div className="max-h-96 overflow-y-auto">
                            {notifications.length > 0 && (
                                <ul className="divide-y divide-white/5">
                                    {notifications.map((n) => (
                                        <li key={n.id}>
                                            <button
                                                onClick={() => handleNotificationClick(n)}
                                                className={`w-full flex items-start gap-3 px-4 py-3 text-left transition-colors ${n.readAt ? 'hover:bg-white/5' : 'bg-sky-500/5 hover:bg-sky-500/10'}`}
                                            >
                                                <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-300 flex items-center justify-center shrink-0">
                                                    <i className={`fa-solid ${TYPE_ICON[n.type] || 'fa-bell'} text-sm`} />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-center gap-2">
                                                        <div className={`text-sm font-semibold truncate ${n.readAt ? 'text-slate-300' : 'text-white'}`}>{n.title}</div>
                                                        {!n.readAt && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" aria-label="Unread" />}
                                                    </div>
                                                    {n.body && <div className="text-[11px] text-slate-500 truncate">{n.body}</div>}
                                                    <div className="text-[10px] text-slate-600 mt-0.5">{relativeTime(n.createdAt)}</div>
                                                </div>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}

                            {count > 0 && (
                                <>
                                    <div className="px-4 pt-3 pb-1 text-[10px] font-mono uppercase tracking-widest text-slate-500 border-t border-white/5">
                                        Attention Required
                                    </div>
                                    <ul className="divide-y divide-white/5">
                                        {items.map((item) => {
                                            const a = ACCENTS[SAFE_ACCENT[item.accent]];
                                            return (
                                                <li key={item.id}>
                                                    <button
                                                        onClick={() => handleActionClick(item)}
                                                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
                                                    >
                                                        <div className={`w-8 h-8 rounded-lg ${a.bg} border ${a.border} ${a.text} flex items-center justify-center shrink-0`}>
                                                            <i className={`fa-solid ${item.icon} text-sm`} />
                                                        </div>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="text-sm font-semibold text-white truncate">{item.title}</div>
                                                            {item.subtitle && (
                                                                <div className="text-[11px] text-slate-500 truncate">{item.subtitle}</div>
                                                            )}
                                                        </div>
                                                        <i className="fa-solid fa-chevron-right text-slate-600 text-xs shrink-0" />
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
