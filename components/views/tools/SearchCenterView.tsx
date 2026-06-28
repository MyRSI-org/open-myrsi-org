import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useHR } from '../../../contexts/HRContext';
import { useOperations } from '../../../contexts/OperationsContext';
import { useNavigation } from '../../../contexts/NavigationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';
import { useAuth } from '../../../contexts/AuthContext';
import { HydratedIntelligenceReport } from '../../../types';
import SearchFiltersPanel from './searchCenter/SearchFiltersPanel';
import SearchResultsList from './searchCenter/SearchResultsList';
import { EmptyIdle, EmptyNoMatches, EmptyNoTypes } from './searchCenter/EmptyStates';
import { useSearchFilters } from './searchCenter/hooks/useSearchFilters';
import { useGlobalSearchResults } from './searchCenter/hooks/useGlobalSearchResults';
import { usePrefetchSearchSubsets } from './searchCenter/hooks/usePrefetchSearchSubsets';
import { useSearchKeyboardNav } from './searchCenter/hooks/useSearchKeyboardNav';
import { buildAclContext } from './searchCenter/acl';

const SCROLL_CONTAINER_ID = 'search-scroll';

const SearchCenterView: React.FC = () => {
    const nav = useNavigation();
    const modal = useModalRegistry();
    const { globalSearchQuery, setGlobalSearchQuery } = nav;
    const {
        hydratedServiceRequests,
        wikiPages,
        rpcAction,
    } = useData();
    const { allUsers } = useMembers();
    const { hrApplicants, hrInterviews, hrJobs } = useHR();
    const { warrants, operations } = useOperations();
    const { hasPermission, currentUser } = useAuth();

    const [intelResults, setIntelResults] = useState<HydratedIntelligenceReport[]>([]);
    const [isSearchingIntel, setIsSearchingIntel] = useState(false);
    const [isFiltersDrawerOpen, setIsFiltersDrawerOpen] = useState(false);
    // Debounced result-count message for the aria-live region. Only ever set by
    // the 300ms timer below (when there IS a query); the empty-query "clear" is
    // derived during render rather than via a synchronous effect setState.
    const [debouncedAnnouncement, setDebouncedAnnouncement] = useState('');

    const filtersApi = useSearchFilters();
    const prefetch = usePrefetchSearchSubsets();

    // ACL context — recomputed when user / permission state changes.
    const acl = useMemo(
        () => buildAclContext(currentUser, hasPermission),
        [currentUser, hasPermission],
    );

    // Server-side intel search — debounced 600ms (preserved from original).
    useEffect(() => {
        const fetchIntel = async () => {
            if (!globalSearchQuery.trim() || !hasPermission('intel:view')) {
                setIntelResults([]);
                return;
            }
            setIsSearchingIntel(true);
            try {
                const results = await rpcAction('intel:search', { query: globalSearchQuery });
                setIntelResults(results || []);
            } catch (e) {
                console.error('Intel search failed', e);
            } finally {
                setIsSearchingIntel(false);
            }
        };
        const timer = setTimeout(fetchIntel, 600);
        return () => clearTimeout(timer);
    }, [globalSearchQuery, hasPermission, rpcAction]);

    const { results, totalCount, counts } = useGlobalSearchResults({
        query: globalSearchQuery,
        filters: filtersApi.filters,
        acl,
        allUsers,
        serviceRequests: hydratedServiceRequests,
        warrants,
        operations,
        intelReports: intelResults,
        hrApplicants,
        hrInterviews,
        hrJobs,
        wikiPages,
        isSearchingIntel,
    });

    // Aria-live announcement — debounced 300ms. The empty-query reset is handled
    // by the render-time derivation below (announcement), so this effect only
    // owns the debounced "N results" message and never sets state synchronously.
    useEffect(() => {
        const trimmed = globalSearchQuery.trim();
        if (!trimmed) return;
        const handle = setTimeout(() => {
            const typesHit = Object.values(counts).filter(n => n > 0).length;
            setDebouncedAnnouncement(`${totalCount} ${totalCount === 1 ? 'result' : 'results'} across ${typesHit} ${typesHit === 1 ? 'type' : 'types'}`);
        }, 300);
        return () => clearTimeout(handle);
    }, [totalCount, counts, globalSearchQuery]);

    // When the query is empty the live region clears immediately (no debounce);
    // otherwise it shows the most recent debounced message. Deriving this during
    // render is exactly equivalent to the old synchronous setAnnouncement('').
    const announcement = globalSearchQuery.trim() ? debouncedAnnouncement : '';

    // Keyboard nav — listener attaches to the page container, scrolls the
    // scroll container directly.
    const pageRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Filter out the loading sentinel from "real activatable" rows so that
    // ↑/↓/Enter doesn't act on skeletons.
    const activatableCount = useMemo(
        () => results.filter(r => r.type !== 'intel-loading').length,
        [results],
    );

    const dispatchActivation = useCallback((index: number) => {
        const result = results[index];
        if (!result || result.type === 'intel-loading') return;
        switch (result.type) {
            case 'personnel': nav.viewMemberProfile(result.data); break;
            case 'mission':   nav.viewRequestDetails(result.data); break;
            case 'warrant':   modal.openUpdateWarrantModal(result.data); break;
            case 'operation': nav.viewOperationDetails(result.data); break;
            case 'intel':     nav.viewDossier(result.data.targetId); break;
            case 'hr':
                if (result.subtype === 'application') modal.openGenericCaseFileModal(result.data);
                else if (result.subtype === 'interview') modal.openConductInterviewModal(result.data);
                else nav.setActiveView('hr');
                break;
            case 'wiki': nav.setActiveView('wiki'); break;
        }
    }, [results, nav, modal]);

    const keyboardNav = useSearchKeyboardNav({
        itemCount: activatableCount,
        onActivate: (idx) => {
            // The skeleton sentinel is at index 0 when present — offset.
            const sentinelOffset = results[0]?.type === 'intel-loading' ? 1 : 0;
            dispatchActivation(idx + sentinelOffset);
        },
        listenerRef: pageRef,
        scrollContainerRef: scrollRef,
        rowHeight: 96, // SEARCH_ROW_HEIGHT (88) + 8px gap
    });

    const handleActivate = useCallback((index: number) => {
        keyboardNav.setSelectedIndex(index);
        dispatchActivation(index);
    }, [keyboardNav, dispatchActivation]);

    const trimmedQuery = globalSearchQuery.trim();
    const noTypesSelected = filtersApi.selectedTypeCount === 0;
    const showResults = trimmedQuery && !noTypesSelected && results.length > 0;
    const showNoMatches = trimmedQuery && !noTypesSelected && results.length === 0 && !isSearchingIntel;

    return (
        <div
            ref={pageRef}
            tabIndex={0}
            id={SCROLL_CONTAINER_ID}
            className="flex flex-col h-full animate-fade-in p-4 md:p-6 lg:p-8 overflow-y-auto custom-scrollbar focus:outline-hidden"
        >
            {/* Aria-live region (screen readers only) */}
            <div role="status" aria-live="polite" className="sr-only">
                {announcement}
            </div>

            <div className="flex flex-col gap-4 mb-6">
                <h1 className="text-2xl md:text-3xl font-black text-white uppercase tracking-tight flex items-center">
                    <i className="fa-solid fa-magnifying-glass text-sky-500 mr-3 md:mr-4" aria-hidden />
                    Global Search Center
                </h1>

                <div className="relative max-w-4xl">
                    <input
                        type="text"
                        value={globalSearchQuery}
                        onChange={(e) => setGlobalSearchQuery(e.target.value)}
                        placeholder="Search by Handle, Name, Location, ID, or Keywords..."
                        className="w-full bg-slate-800 border border-slate-600 rounded-xl py-3 md:py-4 pl-5 pr-12 text-base md:text-lg text-white placeholder:text-slate-500 focus:ring-2 focus:ring-sky-500 focus:border-sky-500 outline-hidden shadow-xl transition-all"
                        autoFocus
                    />
                    {isSearchingIntel && (
                        <div className="absolute right-4 top-1/2 -translate-y-1/2">
                            <i className="fa-solid fa-circle-notch animate-spin text-sky-500 text-xl" aria-hidden />
                        </div>
                    )}
                </div>

                <div className="lg:hidden">
                    <button
                        onClick={() => setIsFiltersDrawerOpen(true)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-white/10 bg-slate-900/60 text-slate-200 hover:border-sky-500/40 hover:text-sky-300 transition-colors text-sm font-bold uppercase tracking-wider"
                    >
                        <i className="fa-solid fa-filter" aria-hidden />
                        Filters
                        {filtersApi.activeCount > 0 && (
                            <span className="ml-1 px-1.5 py-0.5 rounded-full bg-sky-500/20 text-sky-300 text-[10px] font-mono font-black">
                                {filtersApi.activeCount}
                            </span>
                        )}
                    </button>
                </div>
            </div>

            <div className="flex gap-6 flex-1 min-h-0">
                <SearchFiltersPanel api={filtersApi} prefetch={prefetch} />

                <SearchFiltersPanel
                    api={filtersApi}
                    prefetch={prefetch}
                    asDrawer
                    isDrawerOpen={isFiltersDrawerOpen}
                    onCloseDrawer={() => setIsFiltersDrawerOpen(false)}
                />

                <div ref={scrollRef} className="flex-1 min-w-0 flex flex-col">
                    {trimmedQuery && results.length > 0 && (
                        <div className="flex items-center justify-between mb-3 text-[10px] font-mono uppercase tracking-widest text-slate-500">
                            <span>
                                <span className="text-sky-400 font-black">{totalCount}</span>
                                {' '}
                                {totalCount === 1 ? 'result' : 'results'}
                            </span>
                            {keyboardNav.selectedIndex >= 0 && (
                                <span className="hidden md:inline">
                                    <kbd className="px-1.5 py-0.5 rounded-sm bg-slate-900/60 border border-white/10 text-slate-400">↑↓</kbd>
                                    {' '}navigate
                                    {' '}<kbd className="px-1.5 py-0.5 rounded-sm bg-slate-900/60 border border-white/10 text-slate-400">Enter</kbd>
                                    {' '}open
                                </span>
                            )}
                        </div>
                    )}

                    {!trimmedQuery ? (
                        <EmptyIdle />
                    ) : noTypesSelected ? (
                        <EmptyNoTypes />
                    ) : showNoMatches ? (
                        <EmptyNoMatches query={trimmedQuery} />
                    ) : showResults ? (
                        <SearchResultsList
                            results={results}
                            selectedIndex={keyboardNav.selectedIndex}
                            onActivate={handleActivate}
                            scrollContainerId={SCROLL_CONTAINER_ID}
                        />
                    ) : null}
                </div>
            </div>
        </div>
    );
};

export default SearchCenterView;
