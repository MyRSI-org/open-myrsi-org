import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useIntel } from '../../../contexts/IntelContext';
import { useAuth } from '../../../contexts/AuthContext';

import { HydratedIntelligenceReport, DossierData, IntelThreatLevel, IntelSubjectType } from '../../../types';
import { VirtualizedList } from '../../ui/VirtualizedList';
import { DataTableView, TableColumn } from '../../ui/DataTableView';

import IntelligenceReportCard from './IntelligenceReportCard';
import BulletinCard from './BulletinCard';
import DossierView from './DossierView';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import { ACCENTS } from '../../shared/ui/accents';
import { threatAccent, threatIcon, threatLabel } from './intelStyles';
import { useNotification } from '../../../contexts/NotificationContext';
import { useNavigation } from '../../../contexts/NavigationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

/** String coercion — guarantees a primitive string for JSX rendering. */
const s = (v: unknown, fallback = ''): string => {
    if (v == null) return fallback;
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return fallback;
};

interface FeedItem {
    id: string;
    type: 'report';
    data: HydratedIntelligenceReport;
}

/**
 * Deep-sanitize dossier data from the server.
 * Guarantees every field is a renderable primitive — prevents React error #300.
 */
const sanitizeDossier = (data: any): DossierData | null => {
    if (!data || typeof data !== 'object') return null;

    const str = (v: any): string => {
        if (typeof v === 'string') return v;
        if (typeof v === 'number') return String(v);
        return '';
    };

    const sanitizeMarker = (m: any) => {
        if (!m || typeof m !== 'object') return null;
        return { id: typeof m.id === 'number' ? m.id : 0, code: str(m.code), name: str(m.name) };
    };

    const sanitizeUser = (u: any) => {
        if (!u || typeof u !== 'object') return undefined;
        return {
            ...u,
            id: typeof u.id === 'number' ? u.id : 0,
            name: str(u.name),
            avatar: str(u.avatar),
        };
    };

    const sanitizeReport = (r: any) => {
        if (!r || typeof r !== 'object') return null;
        return {
            id: str(r.id),
            targetId: str(r.targetId),
            subjectType: str(r.subjectType),
            threatLevel: str(r.threatLevel),
            summary: str(r.summary),
            tags: Array.isArray(r.tags) ? r.tags.map(str) : [],
            evidenceUrls: Array.isArray(r.evidenceUrls) ? r.evidenceUrls.map(str) : [],
            affiliatedOrg: r.affiliatedOrg != null ? str(r.affiliatedOrg) : undefined,
            externalAuthor: r.externalAuthor != null ? str(r.externalAuthor) : undefined,
            sourceFeedLabel: r.sourceFeedLabel != null ? str(r.sourceFeedLabel) : undefined,
            createdAt: str(r.createdAt),
            classificationLevel: typeof r.classificationLevel === 'number' ? r.classificationLevel : 0,
            limitingMarkers: Array.isArray(r.limitingMarkers)
                ? r.limitingMarkers.map(sanitizeMarker).filter(Boolean)
                : [],
            createdBy: sanitizeUser(r.createdBy),
            createdById: typeof r.createdById === 'number' ? r.createdById : undefined,
        };
    };

    const sanitizeWarrant = (w: any) => {
        if (!w || typeof w !== 'object') return null;
        return {
            id: str(w.id),
            targetRsiHandle: str(w.targetRsiHandle),
            reason: str(w.reason),
            action: str(w.action),
            status: str(w.status),
            notes: w.notes != null ? str(w.notes) : undefined,
            uecReward: typeof w.uecReward === 'number' ? w.uecReward : 0,
            issuedAt: str(w.issuedAt),
            issuedBy: typeof w.issuedBy === 'number' ? w.issuedBy : 0,
            issuedByUser: sanitizeUser(w.issuedByUser),
            claimedBy: typeof w.claimedBy === 'number' ? w.claimedBy : undefined,
            claimedByUser: sanitizeUser(w.claimedByUser),
            claimedAt: w.claimedAt != null ? str(w.claimedAt) : undefined,
            sourceFeedId: w.sourceFeedId != null ? str(w.sourceFeedId) : undefined,
            sourceFeedLabel: w.sourceFeedLabel != null ? str(w.sourceFeedLabel) : undefined,
            externalId: w.externalId != null ? str(w.externalId) : undefined,
        };
    };

    const sanitizeRequest = (r: any) => {
        if (!r || typeof r !== 'object') return null;
        return {
            ...r,
            id: r.id ?? 0,
            serviceType: str(r.serviceType),
            description: str(r.description),
            status: str(r.status),
            location: r.location != null ? str(r.location) : null,
            createdAt: str(r.createdAt),
        };
    };

    const sanitizeOp = (op: any) => {
        if (!op || typeof op !== 'object') return null;
        return {
            ...op,
            id: op.id ?? 0,
            name: str(op.name),
            status: str(op.status),
            type: str(op.type),
        };
    };

    const sanitizeAffiliate = (a: any) => {
        if (!a || typeof a !== 'object') return null;
        return {
            targetId: str(a.targetId),
            threatLevel: str(a.threatLevel),
            lastReportedAt: str(a.lastReportedAt),
        };
    };

    return {
        targetId: str(data.targetId),
        reports: Array.isArray(data.reports) ? data.reports.map(sanitizeReport).filter(Boolean) : [],
        warrants: Array.isArray(data.warrants) ? data.warrants.map(sanitizeWarrant).filter(Boolean) : [],
        requests: Array.isArray(data.requests) ? data.requests.map(sanitizeRequest).filter(Boolean) : [],
        operations: Array.isArray(data.operations) ? data.operations.map(sanitizeOp).filter(Boolean) : [],
        affiliates: Array.isArray(data.affiliates) ? data.affiliates.map(sanitizeAffiliate).filter(Boolean) : [],
        cachedSummary: typeof data.cachedSummary === 'string' ? data.cachedSummary : undefined,
        cachedSummaryDate: typeof data.cachedSummaryDate === 'string' ? data.cachedSummaryDate : undefined,
    } as DossierData;
};

const IntelligenceView: React.FC = () => {
    const { rpcAction, isFetching } = useData();
    const { intelHubStats, intelDataVersion, activeBulletins, deleteBulletin, deleteIntelReport } = useIntel();
    const { hasPermission, currentUser } = useAuth();
    const { confirm } = useNotification();
    const { selectedDossierTarget, setSelectedDossierTarget, setSelectedBulletin } = useNavigation();
    const { openCreateIntelWindow, openIntelReportWindow, intelRefreshTrigger, setShowCreateBulletinModal } = useModalRegistry();

    const [searchTerm, setSearchTerm] = useState('');
    const [activeSubject, setActiveSubject] = useState<string | null>(null);
    const [dossier, setDossier] = useState<DossierData | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [utcTime, setUtcTime] = useState(() => new Date());
    const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

    /** Drilldown breadcrumb stack — tail is the currently-open target. */
    const [dossierStack, setDossierStack] = useState<string[]>([]);

    /** Hub filter state. Single tag in v1 — the UI swaps the chip when a different tag is clicked. */
    const [threatFilter, setThreatFilter] = useState<IntelThreatLevel | 'all'>('all');
    const [subjectFilter, setSubjectFilter] = useState<IntelSubjectType | 'all'>('all');
    const [tagFilter, setTagFilter] = useState<string | null>(null);
    const [warrantsOnly, setWarrantsOnly] = useState(false);

    /** Hub paginated archive state — drives the cursor-paginated `intel:list` feed. */
    const [reports, setReports] = useState<HydratedIntelligenceReport[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [isLoadingPage, setIsLoadingPage] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    /** Bumped on each realtime intel update while the user is past page 1 —
     *  surfaces the "X new reports" pill so we don't yank their scroll. */
    const [pendingNewCount, setPendingNewCount] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => setUtcTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    const [itemHeight, setItemHeight] = useState(window.innerWidth < 768 ? 380 : 320);

    useEffect(() => {
        const handleResize = () => setItemHeight(window.innerWidth < 768 ? 380 : 320);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const canViewDossiers = hasPermission('intel:view');
    const userMarkers = useMemo(() => new Set(currentUser?.limitingMarkers?.map((m: any) => m.id) || []), [currentUser]);

    const hasClearanceAccess = useCallback((item: { classificationLevel: number; limitingMarkers?: { id: number }[]; createdById?: number; createdBy?: { id: number } }) => {
        const authorId = (item as any).createdBy?.id || (item as any).createdById;
        if (authorId === currentUser?.id) return true;
        const userLevel = currentUser?.clearanceLevel?.level || 0;
        if (item.classificationLevel > userLevel) return false;
        if (item.limitingMarkers && item.limitingMarkers.length > 0) {
            return item.limitingMarkers.every(m => userMarkers.has(m.id));
        }
        return true;
    }, [currentUser, userMarkers]);

    const hasReportAccess = useCallback((report: HydratedIntelligenceReport) => {
        return hasClearanceAccess(report);
    }, [hasClearanceAccess]);

    const filteredBulletins = useMemo(() => {
        return activeBulletins.filter(b => hasClearanceAccess(b));
    }, [activeBulletins, hasClearanceAccess]);

    const loadDossier = useCallback(async (targetId: string) => {
        if (!canViewDossiers) return;
        setIsLoading(true);
        // Only clear the dossier when entering from the hub (first load). On
        // affiliate drilldowns we keep the previous dossier visible so the
        // hub doesn't briefly flash between transitions.
        if (!activeSubject) setDossier(null);
        try {
            const data = await rpcAction('intel:get_dossier', { targetId });
            const sanitized = sanitizeDossier(data);
            if (sanitized) {
                sanitized.reports = sanitized.reports.filter(hasReportAccess);
                setDossier(sanitized);
            } else {
                console.error('[Intel] Malformed dossier response');
                setDossier(null);
            }
            setActiveSubject(targetId);
            document.getElementById('content-area')?.scrollTo({ top: 0, behavior: 'smooth' });
        } catch (e) {
            console.error(e);
        } finally {
            setTimeout(() => setIsLoading(false), 300);
        }
    }, [rpcAction, canViewDossiers, hasReportAccess, activeSubject]);

    /** Enter a new dossier from the hub — resets the stack. */
    const fetchSubject = useCallback((targetId: string) => {
        setDossierStack([targetId]);
        loadDossier(targetId);
    }, [loadDossier]);

    // Cross-view pre-selection: Diplomacy dossier rows fire `app:intel-open-subject`
    // with a subject id after it navigates the user here. We fetch that dossier
    // automatically so they land on the partner's intel page, not the hub.
    useEffect(() => {
        const handler = (e: Event) => {
            const subjectId = (e as CustomEvent).detail?.subjectId;
            if (!subjectId || !canViewDossiers) return;
            fetchSubject(String(subjectId));
        };
        window.addEventListener('app:intel-open-subject', handler as EventListener);
        return () => window.removeEventListener('app:intel-open-subject', handler as EventListener);
    }, [fetchSubject, canViewDossiers]);

    /** Drill down into an affiliate — pushes onto the stack. */
    const drilldownToAffiliate = useCallback((targetId: string) => {
        if (!targetId) return;
        setDossierStack(prev => [...prev, targetId]);
        loadDossier(targetId);
    }, [loadDossier]);

    /** Jump to a specific stack index. Index -1 returns to the hub. */
    const handleBreadcrumbJump = useCallback((index: number) => {
        if (index < 0) {
            setDossierStack([]);
            setActiveSubject(null);
            setDossier(null);
            setSelectedDossierTarget(null);
            return;
        }
        const newStack = dossierStack.slice(0, index + 1);
        setDossierStack(newStack);
        const target = newStack[newStack.length - 1];
        if (target) loadDossier(target);
    }, [dossierStack, loadDossier, setSelectedDossierTarget]);

    const refreshDossierQuietly = useCallback(async (targetId: string) => {
        if (!canViewDossiers) return;
        try {
            const data = await rpcAction('intel:get_dossier', { targetId });
            const sanitized = sanitizeDossier(data);
            if (sanitized) {
                sanitized.reports = sanitized.reports.filter(hasReportAccess);
                setDossier(sanitized);
            }
        } catch (e) {
            console.error("[Intel] Quiet dossier refresh failed:", e);
        }
    }, [rpcAction, canViewDossiers, hasReportAccess]);

    // Synchronizes the dossier view with the externally-controlled navigation
    // target (useNavigation). Opening a dossier resets the stack and kicks off
    // an async RPC fetch (loadDossier) — external-system synchronization with a
    // data fetch. The work is launched from an inline async function (React's
    // documented effect-fetch pattern); fetchSubject's synchronous stack/loading
    // sets run before the first await, so their timing is unchanged.
    useEffect(() => {
        if (!selectedDossierTarget) return;
        const target = selectedDossierTarget;
        void (async () => { fetchSubject(target); })();
    }, [selectedDossierTarget, fetchSubject]);

    /** Cursor-paginated archive fetch. All filters and search are pushed
     *  server-side via `intel:list`. Clearance filtering happens client-side
     *  page-by-page (server can't know each requesting user's markers cheaply). */
    const fetchFirstPage = useCallback(async () => {
        if (selectedDossierTarget) return;
        setIsLoadingPage(true);
        try {
            const result = await rpcAction('intel:list', {
                limit: 50,
                cursor: null,
                threatLevel: threatFilter === 'all' ? undefined : threatFilter,
                subjectType: subjectFilter === 'all' ? undefined : subjectFilter,
                tag: tagFilter || undefined,
                warrantsOnly: warrantsOnly || undefined,
                q: searchTerm.trim() || undefined,
            });
            const accessible = (result?.items || []).filter(hasReportAccess);
            setReports(accessible);
            setNextCursor(result?.nextCursor ?? null);
            setHasMore(Boolean(result?.hasMore));
            setPendingNewCount(0);
        } catch (e) {
            console.error('Failed to fetch reports', e);
        } finally {
            setIsLoadingPage(false);
        }
    }, [rpcAction, selectedDossierTarget, threatFilter, subjectFilter, tagFilter, warrantsOnly, searchTerm, hasReportAccess]);

    const loadMore = useCallback(async () => {
        if (isLoadingMore || !hasMore || !nextCursor) return;
        setIsLoadingMore(true);
        try {
            const result = await rpcAction('intel:list', {
                limit: 50,
                cursor: nextCursor,
                threatLevel: threatFilter === 'all' ? undefined : threatFilter,
                subjectType: subjectFilter === 'all' ? undefined : subjectFilter,
                tag: tagFilter || undefined,
                warrantsOnly: warrantsOnly || undefined,
                q: searchTerm.trim() || undefined,
            });
            const accessible = (result?.items || []).filter(hasReportAccess);
            setReports(prev => {
                const seen = new Set(prev.map(r => r.id));
                return [...prev, ...accessible.filter((r: any) => !seen.has(r.id))];
            });
            setNextCursor(result?.nextCursor ?? null);
            setHasMore(Boolean(result?.hasMore));
        } catch (e) {
            console.error('Failed to load more intel reports', e);
        } finally {
            setIsLoadingMore(false);
        }
    }, [isLoadingMore, hasMore, nextCursor, rpcAction, threatFilter, subjectFilter, tagFilter, warrantsOnly, searchTerm, hasReportAccess]);

    /** Debounced first-page fetch on filter/search change. 300ms covers fast
     *  typing without thrashing the API; identity of fetchFirstPage flips
     *  whenever any filter input does, so this re-fires naturally. */
    useEffect(() => {
        const t = setTimeout(fetchFirstPage, 300);
        return () => clearTimeout(t);
    }, [fetchFirstPage]);

    /** If the first page returns a sparse set (clearance filtering can thin
     *  pages aggressively), eagerly fetch the next page so the viewport
     *  isn't empty. The infinite-scroll guard in `loadMore` makes this safe. */
    useEffect(() => {
        if (!isLoadingPage && hasMore && reports.length > 0 && reports.length < 15) {
            // Data-fetch side-effect: auto-advance cursor pagination when clearance
            // filtering thins a page. Launched from an inline async function (React's
            // documented effect-fetch pattern); loadMore's only synchronous setState
            // is its in-flight loading flag (guarded against re-entry), which runs
            // before the first await, so its timing is unchanged.
            void (async () => { await loadMore(); })();
        }
    }, [isLoadingPage, hasMore, reports.length, loadMore]);

    /** Realtime intel updates: silently refresh if the user is on page 1,
     *  otherwise surface the "X new reports" pill so we don't yank scroll.
     *
     *  The "past page 1" branch is a synchronous state adjustment (bump the pill
     *  counter), so it uses the React-documented "adjust state during render"
     *  pattern with a previous-value tracker — this fires exactly once per
     *  distinct intelDataVersion bump, reading the current nextCursor, equivalent
     *  to the old effect. The "on page 1" branch is an async refetch and stays in
     *  an effect below. */
    const [prevIntelDataVersion, setPrevIntelDataVersion] = useState(intelDataVersion);
    if (intelDataVersion !== prevIntelDataVersion) {
        setPrevIntelDataVersion(intelDataVersion);
        if (intelDataVersion !== 0 && nextCursor) {
            setPendingNewCount(c => c + 1);
        }
    }

    // Latest-value refs so the trigger-keyed effects below read the current
    // nextCursor/fetchFirstPage without listing them as deps (which would re-fire
    // on every filter-driven identity change). Declared before those effects so
    // that, within a single commit, the refs are updated first (effects run in
    // declaration order).
    const nextCursorRef = useRef(nextCursor);
    useEffect(() => { nextCursorRef.current = nextCursor; }, [nextCursor]);
    const fetchFirstPageRef = useRef(fetchFirstPage);
    useEffect(() => { fetchFirstPageRef.current = fetchFirstPage; }, [fetchFirstPage]);

    useEffect(() => {
        // Async page-1 refetch on realtime intel_update bumps. Launched from an
        // inline async function (React's documented effect-fetch pattern);
        // fetchFirstPage's only synchronous setState is its in-flight loading flag,
        // which runs before the first await — timing is unchanged. The pill-bump
        // branch is handled by the render-time tracker above, so it is not here.
        if (intelDataVersion !== 0 && !nextCursorRef.current) {
            void (async () => { await fetchFirstPageRef.current(); })();
        }
    }, [intelDataVersion]);

    /** Modal-driven create/edit also bumps intelRefreshTrigger — refresh page 1. */
    useEffect(() => {
        // Responds to the parent's modal-driven refresh trigger by re-fetching
        // page 1. Launched from an inline async function (React's documented
        // effect-fetch pattern); fetchFirstPage's only synchronous setState is its
        // in-flight loading flag, which runs before the first await — unchanged.
        if (intelRefreshTrigger > 0 && !nextCursorRef.current) {
            void (async () => { await fetchFirstPageRef.current(); })();
        }
    }, [intelRefreshTrigger]);

    const handleDelete = async (id: string, e?: React.MouseEvent) => {
        if (e) e.stopPropagation();
        if (deletingId) return;

        const confirmed = await confirm({
            title: 'Purge Intelligence Record',
            message: 'Are you sure you want to permanently delete this intelligence record? This action cannot be reversed and will be logged.',
            variant: 'danger',
            confirmText: 'Purge Record'
        });
        if (!confirmed) return;

        setDeletingId(id);
        try {
            await deleteIntelReport(id);
            // Optimistic local removal — the realtime intel_update broadcast
            // will follow and refresh stats/index.
            setReports(prev => prev.filter(r => r.id !== id));
            if (activeSubject) {
                setDossier(prev => prev ? ({ ...prev, reports: prev.reports.filter(r => r.id !== id) }) : null);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setDeletingId(null);
        }
    };

    const handleDeleteBulletin = async (id: string) => {
        if (deletingId) return;

        const confirmed = await confirm({
            title: 'Delete Bulletin',
            message: 'Are you sure you want to delete this bulletin? This action cannot be undone.',
            variant: 'danger',
            confirmText: 'Delete Bulletin'
        });
        if (!confirmed) return;

        setDeletingId(id);
        try {
            await deleteBulletin(id);
        } catch (e) {
            console.error(e);
        } finally {
            setDeletingId(null);
        }
    };

    /** All filter logic now happens server-side in `intel:list`; this just
     *  wraps the local paginated `reports` state for the row renderer. */
    const displayItems = useMemo<FeedItem[]>(() => {
        return reports.map(r => ({ id: s(r.id), type: 'report' as const, data: r }));
    }, [reports]);

    const threatColor = (level: string) => {
        switch (level) {
            case 'Critical': return 'text-red-400';
            case 'High': return 'text-orange-400';
            case 'Medium': return 'text-amber-400';
            case 'Low': return 'text-emerald-400';
            default: return 'text-slate-500';
        }
    };

    const intelTableColumns: TableColumn<FeedItem>[] = useMemo(() => [
        { key: 'targetId', label: 'Target', sortable: true, width: '140px', render: (item) => <span className="font-mono font-bold text-white text-xs truncate">{s(item.data.targetId)}</span> },
        { key: 'subjectType', label: 'Type', sortable: true, width: '90px', render: (item) => <span className="text-[10px] uppercase tracking-wider text-slate-400">{s(item.data.subjectType)}</span> },
        { key: 'threatLevel', label: 'Threat', sortable: true, width: '80px', render: (item) => <span className={`text-[10px] font-black uppercase ${threatColor(s(item.data.threatLevel))}`}>{s(item.data.threatLevel)}</span> },
        { key: 'summary', label: 'Summary', render: (item) => <span className="text-xs text-slate-400 truncate block">{s(item.data.summary).substring(0, 80)}{s(item.data.summary).length > 80 ? '...' : ''}</span> },
        { key: 'tags', label: 'Tags', width: '120px', render: (item) => (
            <div className="flex gap-1 flex-wrap">
                {(item.data.tags || []).slice(0, 2).map((t) => <span key={t} className="px-1.5 py-0.5 bg-slate-800 rounded-sm text-[9px] text-slate-400 border border-slate-700">{t}</span>)}
                {(item.data.tags || []).length > 2 && <span className="text-[9px] text-slate-600">+{(item.data.tags || []).length - 2}</span>}
            </div>
        )},
        { key: 'classificationLevel', label: 'Class', sortable: true, width: '50px', render: (item) => <span className="text-[10px] font-mono text-sky-400">{String(item.data.classificationLevel ?? 0)}</span> },
        { key: 'createdAt', label: 'Date', sortable: true, width: '90px', render: (item) => <span className="text-[10px] text-slate-500 font-mono">{s(item.data.createdAt).substring(0, 10)}</span> },
    ], []);

    const handleBulkDelete = async () => {
        if (selectedIds.size === 0) return;
        const confirmed = await confirm({
            title: 'Bulk Delete Intel Records',
            message: `Permanently delete ${selectedIds.size} selected intelligence record${selectedIds.size > 1 ? 's' : ''}? This cannot be undone.`,
            variant: 'danger',
            confirmText: `Delete ${selectedIds.size} Records`
        });
        if (!confirmed) return;
        try {
            const ids = new Set(selectedIds);
            await rpcAction('intel:bulk_delete_reports', { reportIds: Array.from(ids) });
            setReports(prev => prev.filter(r => !ids.has(r.id)));
            setSelectedIds(new Set());
        } catch (e) { console.error(e); }
    };

    const handleBulkAddTags = async () => {
        const input = prompt('Enter tags to add (comma-separated):');
        if (!input) return;
        const tags = input.split(',').map(t => t.trim()).filter(Boolean);
        if (tags.length === 0) return;
        try {
            await rpcAction('intel:bulk_add_tags', { reportIds: Array.from(selectedIds), tags });
            setSelectedIds(new Set());
            await fetchFirstPage();
        } catch (e) { console.error(e); }
    };

    const handleBulkUpdateAffiliation = async () => {
        const input = prompt('Enter affiliated organization name:');
        if (!input) return;
        try {
            await rpcAction('intel:bulk_update_affiliation', { reportIds: Array.from(selectedIds), affiliatedOrg: input.trim() });
            setSelectedIds(new Set());
            await fetchFirstPage();
        } catch (e) { console.error(e); }
    };

    /** Click a tag: close dossier and set the hub's active tag filter.
     *  v1 uses single-tag filtering — clicking another tag swaps it; clicking
     *  the same tag clears it. */
    const handleTagClick = useCallback((tag: string) => {
        setTagFilter(prev => prev === tag ? null : tag);
        if (activeSubject) {
            setActiveSubject(null);
            setDossier(null);
            setSelectedDossierTarget(null);
            setDossierStack([]);
        }
    }, [activeSubject, setSelectedDossierTarget]);

    if (activeSubject && dossier) {
        return (
            <DossierView
                dossier={dossier}
                onBack={() => { setActiveSubject(null); setDossier(null); setSelectedDossierTarget(null); setDossierStack([]); }}
                onRefresh={() => refreshDossierQuietly(activeSubject)}
                onDeleteReport={(id) => handleDelete(id)}
                breadcrumbStack={dossierStack}
                onBreadcrumbJump={handleBreadcrumbJump}
                onDrilldown={drilldownToAffiliate}
                onTagClick={handleTagClick}
                isLoading={isLoading}
            />
        );
    }

    // Hub stats are server-aggregated org-wide counts (not clearance-filtered),
    // so they stay accurate even when the visible feed is paginated/filtered.
    const totalReports = intelHubStats.totalReports;
    const criticalCount = intelHubStats.criticalCount;
    const reports7d = intelHubStats.recentCount7d;
    const clearanceName = s(currentUser?.clearanceLevel?.name, 'STANDARD');

    return (
        <div id="intel-hub-scroller" className="flex flex-col h-full overflow-y-auto overflow-x-hidden bg-slate-950">
            {/* Classification banner (thematic flavor — kept for Intel identity) */}
            <div className="shrink-0 bg-slate-950 border-b border-rose-500/20 px-4 py-1.5 flex items-center justify-between">
                <span className="text-[9px] font-black font-mono text-rose-300/70 uppercase tracking-[0.3em]">{'Clearance: ' + clearanceName}</span>
                <div className="flex items-center gap-4">
                    {isFetching['intel'] && (
                        <span className="text-[9px] text-rose-400 animate-pulse font-mono uppercase tracking-widest flex items-center gap-1.5">
                            <i className="fa-solid fa-arrows-rotate fa-spin text-[8px]"></i> SYNCING
                        </span>
                    )}
                    <span className="text-[9px] font-mono text-slate-600 uppercase tracking-widest">
                        {utcTime.toISOString().replace('T', ' ').substring(0, 19) + ' UTC'}
                    </span>
                </div>
            </div>

            <HeroShell
                chipLabel="MODULE · INTEL HUB"
                chipIcon="fa-satellite-dish"
                chipAccent="rose"
                title="Intelligence Hub"
                subtitle="Field reports, target dossiers, and bulletins. Threat analysis and collection."
                actions={<>
                    {hasPermission('intel:create') && (
                        <>
                            <button onClick={openCreateIntelWindow}
                                className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-widest text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-lg hover:bg-rose-500/20 transition-colors">
                                <i className="fa-solid fa-file-shield"></i> File Report
                            </button>
                            <button onClick={() => setShowCreateBulletinModal(true)}
                                className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-widest text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-lg hover:bg-amber-500/20 transition-colors">
                                <i className="fa-solid fa-tower-broadcast"></i> Bulletin
                            </button>
                        </>
                    )}
                    <div className="flex bg-slate-900/60 rounded-lg border border-slate-700 p-0.5">
                        <button onClick={() => { setViewMode('cards'); setSelectedIds(new Set()); }}
                            className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${viewMode === 'cards' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'text-slate-500 hover:text-slate-300 border border-transparent'}`}>
                            <i className="fa-solid fa-grip"></i>
                        </button>
                        <button onClick={() => { setViewMode('table'); setSelectedIds(new Set()); }}
                            className={`px-3 py-1.5 rounded-md text-[10px] font-black uppercase tracking-wider transition-all ${viewMode === 'table' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'text-slate-500 hover:text-slate-300 border border-transparent'}`}>
                            <i className="fa-solid fa-table-list"></i>
                        </button>
                    </div>
                </>}
                stats={<>
                    <HeroStat icon="fa-folder-open" label="Records" value={totalReports} accent="rose" />
                    <HeroStat icon="fa-triangle-exclamation" label="Critical" value={criticalCount} accent="red" emphasize={criticalCount > 0} />
                    <HeroStat icon="fa-tower-broadcast" label="Bulletins" value={filteredBulletins.length} accent="amber" emphasize={filteredBulletins.length > 0} />
                    <HeroStat icon="fa-clock-rotate-left" label="Reports (7d)" value={reports7d} accent="slate" />
                </>}
            />

            <div className="w-full px-4 sm:px-6 lg:px-8 space-y-8 pb-12 grow mt-6">
                <div className="flex flex-col lg:flex-row gap-3">
                    <div className="relative flex-1 group max-w-2xl">
                        <i className={`fa-solid ${isLoadingPage && searchTerm.trim() ? 'fa-spinner animate-spin text-rose-400' : 'fa-search text-slate-600'} absolute left-4 top-1/2 -translate-y-1/2 transition-colors text-sm`}></i>
                        <input
                            type="text"
                            placeholder="Search targets, organizations, or content…"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full bg-slate-900/60 text-white pl-11 pr-4 py-2.5 rounded-lg border border-slate-700 outline-hidden placeholder:text-slate-600 font-mono text-sm focus:ring-1 focus:ring-rose-500/40 focus:border-rose-500/40 transition-all"
                        />
                    </div>
                    {searchTerm.trim() && (
                        <button onClick={() => setSearchTerm('')} className="bg-slate-900 px-4 py-2.5 rounded-lg text-[10px] font-black uppercase text-slate-400 hover:text-white transition-colors border border-slate-700 tracking-wider shrink-0 w-fit">
                            Clear Search
                        </button>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest mr-1">Threat</span>
                        {(['all', IntelThreatLevel.Critical, IntelThreatLevel.High, IntelThreatLevel.Medium, IntelThreatLevel.Low] as const).map(level => {
                            const isActive = threatFilter === level;
                            const accentK = level === 'all' ? 'slate' : threatAccent(level);
                            const a = ACCENTS[accentK];
                            return (
                                <button
                                    key={level}
                                    onClick={() => setThreatFilter(level)}
                                    className={`inline-flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-black uppercase tracking-widest transition-colors ${
                                        isActive
                                            ? `${a.bg} ${a.border} ${a.text}`
                                            : 'bg-slate-900/40 border-white/10 text-slate-500 hover:text-slate-300'
                                    }`}
                                >
                                    {level !== 'all' && <i className={`fa-solid ${threatIcon(level)}`} aria-hidden />}
                                    {level === 'all' ? 'All' : threatLabel(level)}
                                </button>
                            );
                        })}
                    </div>

                    <div className="flex items-center gap-1 bg-slate-900/40 rounded-lg border border-white/10 p-0.5">
                        {(['all', IntelSubjectType.Person, IntelSubjectType.Organization] as const).map(subj => {
                            const isActive = subjectFilter === subj;
                            return (
                                <button
                                    key={subj}
                                    onClick={() => setSubjectFilter(subj)}
                                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-widest transition-colors ${
                                        isActive ? 'bg-sky-500/20 text-sky-300' : 'text-slate-500 hover:text-slate-300'
                                    }`}
                                >
                                    <i className={`fa-solid ${subj === 'all' ? 'fa-list-ul' : subj === IntelSubjectType.Organization ? 'fa-building' : 'fa-user'}`} aria-hidden />
                                    {subj === 'all' ? 'All' : subj === IntelSubjectType.Organization ? 'Org' : 'Person'}
                                </button>
                            );
                        })}
                    </div>

                    <button
                        onClick={() => setWarrantsOnly(v => !v)}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[10px] font-black uppercase tracking-widest transition-colors ${
                            warrantsOnly
                                ? 'bg-red-500/10 border-red-500/30 text-red-300'
                                : 'bg-slate-900/40 border-white/10 text-slate-500 hover:text-slate-300'
                        }`}
                        title="Show only targets with active cautions"
                    >
                        <i className="fa-solid fa-bullseye" aria-hidden /> Cautions
                    </button>

                    {/* Active tag filter (single tag in v1 — clicking another tag swaps it). */}
                    {tagFilter && (
                        <div className="flex items-center gap-1.5 flex-wrap ml-auto">
                            <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Tag</span>
                            <button
                                onClick={() => setTagFilter(null)}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded-sm border font-mono text-[10px] uppercase tracking-wider bg-sky-500/10 border-sky-500/30 text-sky-300 hover:bg-red-500/10 hover:border-red-500/30 hover:text-red-300 transition-colors"
                                title="Clear tag filter"
                            >
                                <span className="opacity-60">#</span>{tagFilter}
                                <i className="fa-solid fa-xmark ml-0.5 text-[9px]" aria-hidden />
                            </button>
                        </div>
                    )}
                </div>

                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                            <h2 className="text-xs font-black text-white uppercase tracking-[0.2em]">{'Live Bulletin Board'}</h2>
                        </div>
                        <span className="h-px bg-slate-800 grow"></span>
                        {filteredBulletins.length > 0 && (
                            <span className="px-2.5 py-0.5 rounded-sm text-[9px] font-black font-mono bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                {String(filteredBulletins.length) + ' ACTIVE'}
                            </span>
                        )}
                    </div>

                    {filteredBulletins.length > 0 ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {filteredBulletins.map(bulletin => (
                                <BulletinCard
                                    key={s(bulletin.id)}
                                    bulletin={bulletin}
                                    onDelete={handleDeleteBulletin}
                                    isDeleting={deletingId === bulletin.id}
                                    onClick={(b) => setSelectedBulletin(b)}
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="flex items-center justify-center py-8 rounded-lg border border-dashed border-slate-800 bg-black/20">
                            <div className="flex items-center gap-3 text-slate-700">
                                <i className="fa-solid fa-satellite-dish text-sm"></i>
                                <p className="text-[10px] font-mono uppercase tracking-[0.2em]">{'No active bulletins \u2014 all channels clear'}</p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                            <i className="fa-solid fa-folder-tree text-sky-500/60 text-xs"></i>
                            <h2 className="text-xs font-black text-white uppercase tracking-[0.2em]">{'Intelligence Archive'}</h2>
                        </div>
                        <span className="h-px bg-slate-800 grow"></span>
                        <span className="text-[9px] font-mono text-slate-600 uppercase tracking-widest">
                            {hasMore || displayItems.length < totalReports
                                ? `Loaded ${displayItems.length} of ${totalReports} Records`
                                : `${displayItems.length} Records`}
                        </span>
                    </div>

                    {/* "X new reports" pill — surfaces when realtime updates land
                         while the user is scrolled past page 1, so we don't yank
                         their scroll. Click to refresh from the top. */}
                    {pendingNewCount > 0 && (
                        <button
                            onClick={fetchFirstPage}
                            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20 transition-colors text-[11px] font-black uppercase tracking-widest"
                        >
                            <i className="fa-solid fa-arrows-rotate" aria-hidden />
                            {`${pendingNewCount} new ${pendingNewCount === 1 ? 'report' : 'reports'} — refresh feed`}
                        </button>
                    )}

                    {viewMode === 'table' && selectedIds.size > 0 && hasPermission('intel:manage') && (
                        <div className="flex items-center gap-3 p-3 bg-sky-500/10 border border-sky-500/20 rounded-lg animate-fade-in">
                            <span className="text-xs font-bold text-sky-400">{selectedIds.size} selected</span>
                            <span className="h-4 w-px bg-sky-500/30"></span>
                            <button onClick={handleBulkDelete} className="text-[10px] font-bold uppercase tracking-wider text-red-400 hover:text-red-300 px-3 py-1.5 rounded-sm bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 transition-colors">
                                <i className="fa-solid fa-trash mr-1.5"></i>Delete
                            </button>
                            <button onClick={handleBulkUpdateAffiliation} className="text-[10px] font-bold uppercase tracking-wider text-amber-400 hover:text-amber-300 px-3 py-1.5 rounded-sm bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 transition-colors">
                                <i className="fa-solid fa-building mr-1.5"></i>Set Affiliation
                            </button>
                            <button onClick={handleBulkAddTags} className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 hover:text-emerald-300 px-3 py-1.5 rounded-sm bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 transition-colors">
                                <i className="fa-solid fa-tags mr-1.5"></i>Add Tags
                            </button>
                            <button onClick={() => setSelectedIds(new Set())} className="ml-auto text-[10px] text-slate-500 hover:text-slate-300 transition-colors">
                                Clear Selection
                            </button>
                        </div>
                    )}

                    <div className="relative h-full min-h-[400px]">
                        {isLoadingPage && displayItems.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-24">
                                <div className="w-16 h-16 rounded-full border-2 border-sky-500/20 border-t-sky-500 animate-spin mb-6"></div>
                                <p className="text-slate-500 font-mono text-[10px] uppercase tracking-[0.3em]">{'Decrypting intelligence files...'}</p>
                            </div>
                        ) : displayItems.length > 0 ? (
                            <>
                                {viewMode === 'table' ? (
                                    <DataTableView<FeedItem>
                                        scrollContainerId="intel-hub-scroller"
                                        items={displayItems}
                                        columns={intelTableColumns}
                                        itemHeight={56}
                                        selectable={hasPermission('intel:manage')}
                                        selectedIds={selectedIds}
                                        onSelectionChange={setSelectedIds}
                                        onRowClick={(item) => openIntelReportWindow(item.data)}
                                        getId={(item) => item.id}
                                    />
                                ) : (
                                    <div className="h-full">
                                        <VirtualizedList<FeedItem>
                                            scrollContainerId="intel-hub-scroller"
                                            items={displayItems}
                                            itemHeight={itemHeight}
                                            onEndReached={loadMore}
                                            endReachedThreshold={5}
                                            renderItem={(item) => (
                                                <div className="p-2 h-full overflow-visible">
                                                    <IntelligenceReportCard
                                                        report={item.data}
                                                        onClick={() => openIntelReportWindow(item.data)}
                                                        onViewDossier={fetchSubject}
                                                        onDelete={(e) => handleDelete(item.id, e)}
                                                        isDeleting={deletingId === item.id}
                                                        onTagClick={(tag) => setTagFilter(prev => prev === tag ? null : tag)}
                                                    />
                                                </div>
                                            )}
                                        />
                                    </div>
                                )}
                                {(isLoadingMore || hasMore) && (
                                    <div className="flex items-center justify-center py-6 text-slate-500 font-mono text-[10px] uppercase tracking-[0.3em]">
                                        {isLoadingMore ? (
                                            <><i className="fa-solid fa-spinner animate-spin mr-2" aria-hidden />Loading more</>
                                        ) : (
                                            <span className="opacity-60">Scroll for more records</span>
                                        )}
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="flex flex-col items-center justify-center py-32 rounded-lg border border-dashed border-slate-800 bg-black/20">
                                <div className="w-16 h-16 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-700 mb-5">
                                    <i className="fa-solid fa-vault text-2xl"></i>
                                </div>
                                <p className="text-slate-500 font-mono text-xs uppercase tracking-wider">{'No intelligence records match your criteria'}</p>
                                <button onClick={() => { setSearchTerm(''); setThreatFilter('all'); setSubjectFilter('all'); setTagFilter(null); setWarrantsOnly(false); }} className="mt-4 text-sky-500/80 hover:text-sky-400 font-mono font-bold uppercase tracking-widest text-[10px] transition-colors">{'Clear Filters'}</button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default IntelligenceView;
