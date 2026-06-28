import { useEffect, useState } from 'react';
import { useData } from '../../../../../contexts/DataContext';
import { useHR } from '../../../../../contexts/HRContext';
import { useAuth } from '../../../../../contexts/AuthContext';

export interface PrefetchState {
    hr: 'idle' | 'loading' | 'ready' | 'error' | 'forbidden';
    wiki: 'idle' | 'loading' | 'ready' | 'error';
}

/**
 * Pre-fetches HR and Wiki subsets when the search view mounts. These
 * collections are loaded on-demand elsewhere in the app, but search wants
 * them cached so the user can find HR cases and wiki pages without first
 * visiting those views.
 */
export const usePrefetchSearchSubsets = (): PrefetchState & {
    retryHr: () => void;
    retryWiki: () => void;
} => {
    const { refreshHR, refreshWiki, wikiPages } = useData();
    const { hrApplicants, hrJobs } = useHR();
    const { hasPermission } = useAuth();
    const canSeeHr = hasPermission('hr:view');

    // The 'loading' state is entered synchronously at the trigger points (the
    // lazy initializer on mount and the retry handlers) rather than inside an
    // effect, so the effects below contain only the async fetch and its
    // resolution sets. The fetch effect fires whenever the state becomes
    // 'loading' and performs exactly one request per entry.
    const [hrState, setHrState] = useState<PrefetchState['hr']>(() => {
        if (!canSeeHr) return 'forbidden';
        return hrApplicants.length > 0 || hrJobs.length > 0 ? 'ready' : 'loading';
    });
    const [wikiState, setWikiState] = useState<PrefetchState['wiki']>(() =>
        wikiPages.length > 0 ? 'ready' : 'loading',
    );

    // Security gate: re-assert 'forbidden' if the hr:view permission is lost
    // after mount. Adjusting state during render (React-documented pattern) is
    // behavior-equivalent to the old permission-keyed effect — React re-renders
    // before paint — and keeps the denial transition tied to canSeeHr.
    const [prevCanSeeHr, setPrevCanSeeHr] = useState(canSeeHr);
    if (canSeeHr !== prevCanSeeHr) {
        setPrevCanSeeHr(canSeeHr);
        if (!canSeeHr) setHrState('forbidden');
    }

    useEffect(() => {
        if (hrState !== 'loading') return;
        let cancelled = false;
        refreshHR()
            .then(() => { if (!cancelled) setHrState('ready'); })
            .catch(() => { if (!cancelled) setHrState('error'); });
        return () => { cancelled = true; };
    }, [hrState, refreshHR]);

    useEffect(() => {
        if (wikiState !== 'loading') return;
        let cancelled = false;
        refreshWiki()
            .then(() => { if (!cancelled) setWikiState('ready'); })
            .catch(() => { if (!cancelled) setWikiState('error'); });
        return () => { cancelled = true; };
    }, [wikiState, refreshWiki]);

    const retryHr = () => {
        if (!canSeeHr) return;
        setHrState('loading');
    };
    const retryWiki = () => setWikiState('loading');

    return { hr: hrState, wiki: wikiState, retryHr, retryWiki };
};
