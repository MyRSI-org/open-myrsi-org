import { useEffect, useMemo, useState } from 'react';
import { useNow } from './useNow';
import { useData } from '../contexts/DataContext';
import { useHR } from '../contexts/HRContext';
import { useIntel } from '../contexts/IntelContext';
import { useGovernment } from '../contexts/GovernmentContext';
import { useAuth } from '../contexts/AuthContext';
import { ServiceRequestStatus } from '../types';

const NEW_ORDER_WINDOW_MS = 48 * 60 * 60 * 1000;  // 48h
const CRITICAL_BULLETIN_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24h

export type ActionItemType = 'hr' | 'government' | 'request' | 'intel';
export type ActionItemAccent = 'amber' | 'rose' | 'sky' | 'purple' | 'emerald' | 'indigo';
/** 'action' = user needs to do something. 'advisory' = informational notice, no action required. */
export type ActionItemCategory = 'action' | 'advisory';

export interface ActionItem {
    type: ActionItemType;
    id: string;
    title: string;
    subtitle?: string;
    icon: string;
    accent: ActionItemAccent;
    /** 1 = critical, 2 = normal, 3 = informational */
    priority: 1 | 2 | 3;
    category: ActionItemCategory;
    createdAt?: string;
    /** High-level view key the caller should route to */
    targetView: 'requests' | 'government' | 'hr' | 'intel';
    /** Optional specific record id the caller can deep-link to */
    targetId?: string;
    /** Optional sub-tab the caller should activate within the target view */
    targetTab?: string;
}

export interface UseActionRequiredResult {
    items: ActionItem[];
    count: number;
    criticalCount: number;
}

/**
 * Computed-on-demand "user action required" feed. Matches the HR tasks counter
 * pattern in Header.tsx — no persistent notifications table, items surface
 * when a source row is in an actionable state and disappear when it changes.
 */
export function useActionRequired(): UseActionRequiredResult {
    const { hydratedServiceRequests, rpcAction } = useData();
    const { hrApplicants } = useHR();
    const { activeBulletins } = useIntel();
    const { governmentElections, governmentsFeatureConfig } = useGovernment();
    const { currentUser, hasPermission } = useAuth();

    const [recentOrders, setRecentOrders] = useState<any[]>([]);
    const now = useNow();

    const governmentEnabled = governmentsFeatureConfig?.enabled === true;
    const canSeeGovernment = hasPermission('gov:view');

    // Lazy-fetch recent executive orders — also not in DataContext.
    useEffect(() => {
        if (!governmentEnabled || !canSeeGovernment || !currentUser?.id) return;
        let cancelled = false;
        const load = () => {
            rpcAction('gov:list_orders', {}).then((rows: any) => {
                if (!cancelled && Array.isArray(rows)) setRecentOrders(rows);
            }).catch(() => { /* non-blocking */ });
        };
        load();
        const onVisible = () => { if (document.visibilityState === 'visible') load(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible); };
    }, [governmentEnabled, canSeeGovernment, currentUser?.id, rpcAction]);

    const items = useMemo<ActionItem[]>(() => {
        if (!currentUser) return [];
        const out: ActionItem[] = [];
        const uid = currentUser.id;

        // --- HR ---
        // Visibility rules:
        //   Unassigned pool → all HR staff (recruiters/managers/admins) so triage isn't blocked.
        //   Assigned cases → only the assignee. Managers oversee from the HR tab itself, not via alerts.
        //   Member's own apps → strictly self-scoped.
        const isHrStaff = hasPermission('hr:recruiter') || hasPermission('hr:manager') || hasPermission('hr:admin');
        if (isHrStaff) {
            const unassignedCount = hrApplicants.filter((a: any) =>
                !a.assignedRecruiterId && a.status === 'Applied',
            ).length;
            if (unassignedCount > 0) {
                out.push({
                    type: 'hr',
                    id: 'hr-unassigned',
                    title: `${unassignedCount} unassigned ${unassignedCount === 1 ? 'application' : 'applications'}`,
                    subtitle: 'Awaiting recruiter pickup',
                    icon: 'fa-inbox',
                    accent: 'purple',
                    priority: 2,
                    category: 'action',
                    targetView: 'hr',
                    targetTab: 'case-management',
                });
            }

            const assignedToMe = hrApplicants.filter((a: any) =>
                a.assignedRecruiterId === uid &&
                !['Hired', 'Rejected', 'Accepted', 'Withdrawn'].includes(a.status),
            ).length;
            if (assignedToMe > 0) {
                out.push({
                    type: 'hr',
                    id: 'hr-assigned-to-me',
                    title: `${assignedToMe} ${assignedToMe === 1 ? 'case' : 'cases'} assigned to you`,
                    subtitle: 'Your active HR caseload',
                    icon: 'fa-briefcase',
                    accent: 'purple',
                    priority: 2,
                    category: 'action',
                    targetView: 'hr',
                    targetTab: 'case-management',
                });
            }
        } else if (hasPermission('hr:view')) {
            const myAppsCount = hrApplicants.filter((a: any) =>
                a.linkedUserId === uid &&
                !['Hired', 'Rejected', 'Accepted', 'Withdrawn'].includes(a.status),
            ).length;
            if (myAppsCount > 0) {
                out.push({
                    type: 'hr',
                    id: 'hr-my-applications',
                    title: `${myAppsCount} ${myAppsCount === 1 ? 'application' : 'applications'} in progress`,
                    subtitle: 'Your applications under review',
                    icon: 'fa-briefcase',
                    accent: 'purple',
                    priority: 3,
                    category: 'action',
                    targetView: 'hr',
                    targetTab: 'my-applications',
                });
            }
        }

        // --- Service requests assigned to me as responder ---
        const assignedActive = hydratedServiceRequests.filter((r: any) =>
            Array.isArray(r.assignedMemberIds) && r.assignedMemberIds.includes(uid) &&
            [ServiceRequestStatus.Accepted, ServiceRequestStatus.InProgress].includes(r.status),
        );
        for (const r of assignedActive) {
            out.push({
                type: 'request',
                id: `req-${r.id}`,
                title: `${r.serviceType} · ${r.status}`,
                subtitle: r.location || 'Unassigned location',
                icon: 'fa-clipboard-list',
                accent: r.urgency === 'Critical' ? 'rose' : 'sky',
                priority: r.urgency === 'Critical' ? 1 : 2,
                category: 'action',
                createdAt: r.createdAt,
                targetView: 'requests',
                targetId: r.id,
            });
        }

        // --- Pending ratings for the client ---
        const pendingRating = hydratedServiceRequests.filter((r: any) =>
            r.clientId === uid && r.status === ServiceRequestStatus.Success && r.rated === false,
        );
        for (const r of pendingRating) {
            out.push({
                type: 'request',
                id: `rate-${r.id}`,
                title: 'Rate completed request',
                subtitle: `${r.serviceType} · ${r.location || ''}`,
                icon: 'fa-star',
                accent: 'amber',
                priority: 2,
                category: 'action',
                createdAt: r.updatedAt,
                targetView: 'requests',
                targetId: r.id,
            });
        }

        // --- Government: elections open for your vote ---
        if (governmentEnabled && canSeeGovernment && Array.isArray(governmentElections)) {
            const openForVoting = governmentElections.filter((e: any) =>
                ['Voting', 'Runoff'].includes(e.status) && e.hasVoted !== true,
            );
            for (const e of openForVoting) {
                out.push({
                    type: 'government',
                    id: `election-${e.id}`,
                    title: 'Cast your vote',
                    subtitle: e.title || e.position?.name || 'Open election',
                    icon: 'fa-check-to-slot',
                    accent: 'indigo',
                    priority: 2,
                    category: 'action',
                    createdAt: e.votingStart,
                    targetView: 'government',
                    targetId: String(e.id),
                });
            }
        }

        // --- Government: recent executive orders (<48h old, active) ---
        if (governmentEnabled && canSeeGovernment && recentOrders.length > 0) {
            const freshOrders = recentOrders.filter((o: any) => {
                if (o.status !== 'active') return false;
                const issuedAt = o.issued_at || o.issuedAt;
                if (!issuedAt) return false;
                return now - new Date(issuedAt).getTime() < NEW_ORDER_WINDOW_MS;
            });
            for (const o of freshOrders) {
                out.push({
                    type: 'government',
                    id: `order-${o.id}`,
                    title: 'New executive order',
                    subtitle: o.title || 'Executive order issued',
                    icon: 'fa-stamp',
                    accent: 'indigo',
                    priority: 3,
                    category: 'action',
                    createdAt: o.issued_at || o.issuedAt,
                    targetView: 'government',
                    targetId: String(o.id),
                });
            }
        }

        // --- Critical intel bulletins (<24h old, high/critical threat) ---
        if (hasPermission('intel:view') && Array.isArray(activeBulletins)) {
            const critical = activeBulletins.filter((b: any) => {
                const threat = String(b.threatLevel || '').toLowerCase();
                if (threat !== 'high' && threat !== 'critical') return false;
                const createdAt = b.createdAt;
                if (!createdAt) return false;
                return now - new Date(createdAt).getTime() < CRITICAL_BULLETIN_WINDOW_MS;
            });
            for (const b of critical) {
                out.push({
                    type: 'intel',
                    id: `bulletin-${b.id}`,
                    title: 'Critical intel bulletin',
                    subtitle: b.title || 'New bulletin',
                    icon: 'fa-satellite-dish',
                    accent: 'rose',
                    priority: 1,
                    category: 'advisory',
                    createdAt: b.createdAt,
                    targetView: 'intel',
                    targetId: String(b.id),
                });
            }
        }

        // Sort: priority ascending (1 = critical first), then newest first
        out.sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            const at = a.createdAt || '';
            const bt = b.createdAt || '';
            return bt.localeCompare(at);
        });

        return out;
    }, [currentUser, hasPermission, hrApplicants, hydratedServiceRequests, governmentEnabled, canSeeGovernment, governmentElections, recentOrders, activeBulletins, now]);

    return {
        items,
        count: items.length,
        criticalCount: items.filter((i) => i.priority === 1).length,
    };
}
