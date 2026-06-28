import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../../contexts/AuthContext';
import { useGovernment } from '../../../../contexts/GovernmentContext';
import OperationsPanel from './panels/OperationsPanel';
import RequestsPanel from './panels/RequestsPanel';
import IntelPanel from './panels/IntelPanel';
import GovernmentPanel from './panels/GovernmentPanel';

type TabKey = 'operations' | 'requests' | 'intel' | 'government';

interface Tab {
    key: TabKey;
    label: string;
    icon: string;
    render: () => React.ReactNode;
}

const STORAGE_KEY = 'dashboard:active_feature_tab';

export default function FeatureTabs() {
    const { hasPermission } = useAuth();
    const { governmentsFeatureConfig } = useGovernment();

    const governmentEnabled = governmentsFeatureConfig?.enabled === true && hasPermission('gov:view');

    const tabs: Tab[] = useMemo(() => [
        { key: 'operations',  label: 'Operations',  icon: 'fa-crosshairs',     render: () => <OperationsPanel /> },
        { key: 'requests',    label: 'Requests',    icon: 'fa-clipboard-list', render: () => <RequestsPanel /> },
        { key: 'intel',       label: 'Intel Net',   icon: 'fa-satellite-dish', render: () => <IntelPanel /> },
        ...(governmentEnabled  ? [{ key: 'government'  as const, label: 'Government',  icon: 'fa-landmark',       render: () => <GovernmentPanel /> }]  : []),
    ], [governmentEnabled]);

    const [active, setActive] = useState<TabKey>(() => {
        try {
            const saved = sessionStorage.getItem(STORAGE_KEY) as TabKey | null;
            if (saved && tabs.some((t) => t.key === saved)) return saved;
        } catch { /* ignore */ }
        return 'operations';
    });

    // If the active tab disappears (feature disabled / perm lost), fall back to
    // 'operations'. Derived during render so there's no corrective setState in
    // an effect; the next user interaction overwrites `active` normally.
    const effectiveActive: TabKey = tabs.some((t) => t.key === active) ? active : 'operations';

    useEffect(() => {
        try { sessionStorage.setItem(STORAGE_KEY, effectiveActive); } catch { /* ignore */ }
    }, [effectiveActive]);

    const current = tabs.find((t) => t.key === effectiveActive) || tabs[0];

    return (
        <div className="bg-slate-900/60 border border-slate-700/50 rounded-xl overflow-hidden shadow-xl">
            <div className="flex items-center gap-1 px-3 pt-3 overflow-x-auto scrollbar-hide border-b border-white/5 bg-slate-900/40">
                {tabs.map((t) => {
                    const isActive = effectiveActive === t.key;
                    return (
                        <button
                            key={t.key}
                            onClick={() => setActive(t.key)}
                            className={`flex items-center gap-2 px-3 py-2 rounded-t-lg text-xs font-bold uppercase tracking-widest whitespace-nowrap transition-colors ${
                                isActive
                                    ? 'bg-slate-800/80 text-sky-300 border-b-2 border-sky-400 mb-[-2px]'
                                    : 'text-slate-500 hover:text-white hover:bg-white/5 border-b-2 border-transparent'
                            }`}
                        >
                            <i className={`fa-solid ${t.icon} text-[11px]`} />
                            {t.label}
                        </button>
                    );
                })}
            </div>
            <div className="max-h-112 overflow-y-auto custom-scrollbar">
                {current.render()}
            </div>
        </div>
    );
}
