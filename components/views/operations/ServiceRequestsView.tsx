
import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import { ServiceRequestStatus, UserRole, HydratedServiceRequest } from '../../../types';
import { VirtualizedList } from '../../ui/VirtualizedList';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import EmptyState from '../../shared/ui/EmptyState';
import RequestCard from './requests/RequestCard';
import { useNavigation } from '../../../contexts/NavigationContext';

interface ServiceRequestsViewProps {
    openCreateModal: () => void;
    openAdHocModal: () => void;
    openCompleteModal: (req: HydratedServiceRequest) => void;
    openRateRequestModal: (req: HydratedServiceRequest) => void;
    openAddResponderModal: (req: HydratedServiceRequest) => void;
    openUpdateStatusModal: (req: HydratedServiceRequest) => void;
    openTriageModal: (req: HydratedServiceRequest) => void;
}

const ServiceRequestsView: React.FC<ServiceRequestsViewProps> = ({
    openCreateModal,
    openAdHocModal,
    openCompleteModal,
    openRateRequestModal,
    openAddResponderModal,
    openUpdateStatusModal,
    openTriageModal,
}) => {
    const { currentUser, hasPermission } = useAuth();
    const { hydratedServiceRequests, isFetching } = useData();
    const { viewRequestDetails } = useNavigation();
    const [searchTerm, setSearchTerm] = useState('');

    const isStaff = currentUser?.role !== UserRole.Client;
    type Tab = 'pending' | 'unassigned' | 'in_progress' | 'mine' | 'resolved' | 'all';
    const [activeTab, setActiveTab] = useState<Tab>(isStaff ? 'pending' : 'all');
    const [itemHeight, setItemHeight] = useState(window.innerWidth < 768 ? 460 : 335);
    // Snapshot the "resolved in last 7 days" cutoff once at mount so render stays pure
    // (Date.now() must not be called during render).
    const [sevenDaysAgo] = useState(() => Date.now() - 7 * 24 * 60 * 60 * 1000);

    useEffect(() => {
        const handleResize = () => setItemHeight(window.innerWidth < 768 ? 460 : 335);
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    const counts = useMemo(() => {
        const reqs = hydratedServiceRequests || [];
        return {
            submitted: reqs.filter(r => r.status === ServiceRequestStatus.Submitted).length,
            triaged: reqs.filter(r => r.status === ServiceRequestStatus.Triaged).length,
            inProgress: reqs.filter(r => r.status === ServiceRequestStatus.InProgress || r.status === ServiceRequestStatus.Accepted).length,
            mineActive: isStaff && currentUser ? reqs.filter(r =>
                r.assignedMemberIds.includes(currentUser.id) &&
                [ServiceRequestStatus.Accepted, ServiceRequestStatus.InProgress].includes(r.status)
            ).length : 0,
            resolved7d: reqs.filter(r =>
                r.status === ServiceRequestStatus.Success &&
                new Date(r.createdAt).getTime() > sevenDaysAgo
            ).length,
        };
    }, [hydratedServiceRequests, currentUser, isStaff, sevenDaysAgo]);

    const filteredRequests = useMemo(() => {
        if (!currentUser) return [];
        let requests = hydratedServiceRequests || [];

        if (currentUser.role === UserRole.Client) {
            requests = requests.filter(r => r.clientId === currentUser.id);
        }

        if (searchTerm.trim()) {
            const lowerTerm = searchTerm.toLowerCase();
            requests = requests.filter(r =>
                r.description.toLowerCase().includes(lowerTerm) ||
                r.location.toLowerCase().includes(lowerTerm) ||
                r.client?.name.toLowerCase().includes(lowerTerm) ||
                r.client?.rsiHandle.toLowerCase().includes(lowerTerm) ||
                r.unregisteredClientRsiHandle?.toLowerCase().includes(lowerTerm) ||
                r.id.toLowerCase().includes(lowerTerm)
            );
        }

        if (!isStaff) return requests;

        switch (activeTab) {
            case 'pending': return requests.filter(r => r.status === ServiceRequestStatus.Submitted);
            case 'unassigned': return requests.filter(r => r.status === ServiceRequestStatus.Triaged);
            case 'in_progress': return requests.filter(r => r.status === ServiceRequestStatus.InProgress || r.status === ServiceRequestStatus.Accepted);
            case 'mine': return requests.filter(r => r.assignedMemberIds.includes(currentUser.id));
            case 'resolved': return requests.filter(r => [
                ServiceRequestStatus.Success, ServiceRequestStatus.Failed,
                ServiceRequestStatus.Cancelled, ServiceRequestStatus.Refused,
            ].includes(r.status));
            case 'all':
            default:
                return requests;
        }
    }, [hydratedServiceRequests, activeTab, currentUser, searchTerm, isStaff]);

    const tabs: { key: Tab; label: string; icon: string; badge?: number; urgent?: boolean }[] = isStaff ? [
        { key: 'pending', label: 'Pending', icon: 'fa-inbox', badge: counts.submitted || undefined, urgent: counts.submitted > 0 },
        { key: 'unassigned', label: 'Unassigned', icon: 'fa-user-clock', badge: counts.triaged || undefined, urgent: counts.triaged > 0 },
        { key: 'in_progress', label: 'In Progress', icon: 'fa-bolt', badge: counts.inProgress || undefined },
        { key: 'mine', label: 'My Assigned', icon: 'fa-briefcase', badge: counts.mineActive || undefined },
        { key: 'resolved', label: 'Resolved', icon: 'fa-check-double' },
        { key: 'all', label: 'All', icon: 'fa-list-ul' },
    ] : [
        { key: 'all', label: 'My Requests', icon: 'fa-list-ul' },
    ];

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · SERVICE REQUESTS"
                chipIcon="fa-file-invoice"
                chipAccent="sky"
                title="Service Requests"
                subtitle="Mission control and dispatch. Live warrant and intel cross-reference on every request."
                syncing={isFetching['service_requests']}
                actions={<>
                    {hasPermission('request:create_adhoc') && (
                        <HeroActionButton onClick={openAdHocModal} accent="amber" icon="fa-user-pen">
                            Log Ad-hoc
                        </HeroActionButton>
                    )}
                    {hasPermission('request:create') && (
                        <HeroActionButton onClick={openCreateModal} accent="sky" icon="fa-plus">
                            New Request
                        </HeroActionButton>
                    )}
                </>}
                stats={isStaff ? <>
                    <HeroStat icon="fa-inbox" label="Pending" value={counts.submitted} accent="sky" emphasize={counts.submitted > 0} />
                    <HeroStat icon="fa-bolt" label="In Progress" value={counts.inProgress} accent="emerald" />
                    <HeroStat icon="fa-circle-check" label="Resolved (7d)" value={counts.resolved7d} accent="emerald" />
                    <HeroStat icon="fa-briefcase" label="My Active" value={counts.mineActive} accent="amber" emphasize={counts.mineActive > 0} />
                </> : undefined}
                tabs={tabs.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setActiveTab(tab.key)}
                        className={`flex items-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${
                            activeTab === tab.key
                                ? 'text-sky-300 border-sky-400'
                                : 'text-slate-500 border-transparent hover:text-slate-300'
                        }`}
                    >
                        <i className={`fa-solid ${tab.icon}`}></i>
                        {tab.label}
                        {tab.badge != null && (
                            <span className={`ml-1 min-w-[18px] h-[18px] px-1.5 text-[10px] font-bold rounded-full flex items-center justify-center ${tab.urgent ? 'bg-red-500/20 text-red-300 animate-pulse' : 'bg-sky-500/20 text-sky-300'}`}>
                                {tab.badge}
                            </span>
                        )}
                    </button>
                ))}
            />

            <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                <div className="relative mb-4 max-w-2xl">
                    <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500"></i>
                    <input
                        type="search"
                        placeholder="Search requests, IDs, or responders…"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full bg-slate-900/60 text-white pl-12 pr-4 py-2.5 rounded-lg border border-slate-700 outline-hidden placeholder:text-slate-600 font-mono text-sm focus:ring-1 focus:ring-sky-500/50 focus:border-sky-500/40 transition-all"
                    />
                </div>

                {filteredRequests.length > 0 ? (
                    <VirtualizedList
                        items={filteredRequests}
                        itemHeight={itemHeight}
                        renderItem={(request) => (
                            <div className="p-3 h-full">
                                <RequestCard
                                    request={request}
                                    onViewDetails={viewRequestDetails}
                                    onComplete={openCompleteModal}
                                    onRate={openRateRequestModal}
                                    onManageResponders={openAddResponderModal}
                                    onUpdateStatus={openUpdateStatusModal}
                                    onTriage={openTriageModal}
                                />
                            </div>
                        )}
                    />
                ) : (
                    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 mt-4">
                        <EmptyState
                            icon="fa-folder-open"
                            accent="sky"
                            heading="No matching requests"
                            description={searchTerm ? 'Try a different search term or clear filters.' : 'New requests will appear here as clients submit them.'}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

export default ServiceRequestsView;
