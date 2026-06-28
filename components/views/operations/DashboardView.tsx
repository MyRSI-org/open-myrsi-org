
import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import DOMPurify from 'dompurify';
import parse from 'html-react-parser';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { useRequests } from '../../../contexts/RequestsContext';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useConfig } from '../../../contexts/ConfigContext';
import { useHR } from '../../../contexts/HRContext';
import { useOperations } from '../../../contexts/OperationsContext';
import { useIntel } from '../../../contexts/IntelContext';

import { UserRole, ServiceRequestStatus, UrgencyLevel, ServiceType, ThreatLevel, HydratedServiceRequest, OperationStatus, JobPostingStatus, ApplicationStatus, IntelBulletin, WarrantStatus } from '../../../types';
import HeroCard from '../../ui/HeroCard';
import Notice from '../../ui/Notice';
import LocationInput from '../../ui/LocationInput';
import ClientApplyModal from '../../modals/ClientApplyModal';
import AttentionRequiredPanel from './dashboard/AttentionRequiredPanel';
import DashboardHero from './dashboard/DashboardHero';
import DashboardMetrics from './dashboard/DashboardMetrics';
import QuickActionsBar, { QuickAction } from './dashboard/QuickActionsBar';
import FeatureTabs from './dashboard/FeatureTabs';
import ClientDashboardMetrics from './dashboard/ClientDashboardMetrics';
import { useNavigation } from '../../../contexts/NavigationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

const DashboardCard: React.FC<{ children: React.ReactNode, className?: string, title?: React.ReactNode, icon?: string, action?: React.ReactNode }> = ({ children, className = "", title, icon, action }) => (
    <div className={`bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden shadow-xl flex flex-col ${className}`}>
        {(title || icon) && (
            <div className="px-5 py-4 border-b border-white/5 flex justify-between items-center bg-white/5 shrink-0">
                <div className="flex items-center gap-3">
                    {icon && <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-400"><i className={`${icon} text-sm`}></i></div>}
                    <h3 className="font-bold text-white text-sm uppercase tracking-wider">{title}</h3>
                </div>
                {action}
            </div>
        )}
        <div className="p-5 grow overflow-y-auto custom-scrollbar relative">
            {children}
        </div>
    </div>
);

const SectionHeader: React.FC<{ title: string; icon: string; count?: number; viewAllTarget?: string; onViewAll?: (view: string) => void }> = ({ title, icon, count, viewAllTarget, onViewAll }) => (
    <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-slate-800 flex items-center justify-center">
                <i className={`${icon} text-sm text-slate-400`}></i>
            </div>
            <h3 className="font-bold text-white text-sm uppercase tracking-wider">{title}</h3>
            {count !== undefined && count > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-black bg-sky-500/20 text-sky-400 border border-sky-500/30">
                    {count}
                </span>
            )}
        </div>
        {viewAllTarget && onViewAll && (
            <button onClick={() => onViewAll(viewAllTarget)} className="text-[10px] font-bold text-slate-500 hover:text-sky-400 uppercase tracking-wider transition-colors">
                View All <i className="fa-solid fa-arrow-right ml-1"></i>
            </button>
        )}
    </div>
);

const PriorityDispatchFeed: React.FC = () => {
    const { hydratedServiceRequests } = useData();
    const { viewRequestDetails } = useNavigation();
    const fmt = useFormatDate();

    const priorityRequests = useMemo(() => {
        return hydratedServiceRequests
            .filter(r => r.status === ServiceRequestStatus.Submitted || r.status === ServiceRequestStatus.Triaged)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 5);
    }, [hydratedServiceRequests]);

    return (
        <DashboardCard title="Priority Dispatch" icon="fa-solid fa-tower-broadcast" className="h-full">
            {priorityRequests.length > 0 ? (
                <div className="space-y-3">
                    {priorityRequests.map(req => (
                        <div key={req.id} onClick={() => viewRequestDetails(req)} className="p-3 bg-slate-800/50 rounded-sm border border-slate-700 hover:border-sky-500/30 cursor-pointer transition-colors group">
                            <div className="flex justify-between items-start mb-1">
                                <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-sm ${req.urgency === UrgencyLevel.Critical ? 'bg-red-500/20 text-red-400' : 'bg-slate-700 text-slate-300'}`}>{req.urgency}</span>
                                <span className="text-[10px] text-slate-500 font-mono">{fmt(req.createdAt)}</span>
                            </div>
                            <div className="flex justify-between items-center">
                                <h4 className="font-bold text-white text-sm group-hover:text-sky-300 transition-colors">{req.serviceType}</h4>
                                <span className="text-xs text-slate-400">{req.location}</span>
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="flex items-center justify-center h-full text-slate-500 italic text-xs">No pending requests.</div>
            )}
        </DashboardCard>
    );
};

const ActiveOperationsFeed: React.FC = () => {
    const { operations } = useOperations();
    const { viewOperationDetails } = useNavigation();
    const { currentUser, hasPermission } = useAuth();

    const userLevel = useMemo(() => currentUser?.clearanceLevel?.level || 0, [currentUser]);
    const userMarkers = useMemo(() => new Set(currentUser?.limitingMarkers?.map(m => m.id) || []), [currentUser]);

    const activeOps = useMemo(() => {
        return operations
            .filter(op => {
                if (op.status !== OperationStatus.Active) return false;
                if (op.isSpecial || op.ownerId === currentUser?.id || hasPermission('operations:manage')) return true;
                if ((op.clearanceLevel || 0) > userLevel) return false;
                if (op.limitingMarkers && op.limitingMarkers.length > 0) return op.limitingMarkers.every(m => userMarkers.has(m.id));
                return true;
            })
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 5);
    }, [operations, currentUser, userLevel, userMarkers, hasPermission]);

    return (
        <DashboardCard title="Active Operations" icon="fa-solid fa-person-military-rifle" className="h-full">
            {activeOps.length > 0 ? (
                <div className="space-y-3">
                    {activeOps.map(op => (
                        <div key={op.id} onClick={() => viewOperationDetails(op)} className="p-3 bg-slate-800/50 rounded-sm border border-slate-700 hover:border-green-500/30 cursor-pointer transition-colors group">
                            <div className="flex justify-between items-center mb-1">
                                <h4 className="font-bold text-white text-sm group-hover:text-green-300 transition-colors">{op.name}</h4>
                                <span className="text-[10px] bg-green-500/10 text-green-400 px-2 py-0.5 rounded-sm border border-green-500/20 uppercase font-bold">Active</span>
                            </div>
                            <p className="text-xs text-slate-400 line-clamp-1">{op.description}</p>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="flex items-center justify-center h-full text-slate-500 italic text-xs">No operations active.</div>
            )}
        </DashboardCard>
    );
};

const OpenVacanciesFeed: React.FC = () => {
    const { hrJobs } = useHR();
    const { openApplyJobModal } = useModalRegistry();

    const vacancies = useMemo(() => {
        return hrJobs.filter(j => j.status === JobPostingStatus.Open).slice(0, 3);
    }, [hrJobs]);

    return (
        <DashboardCard title="Recruitment Needs" icon="fa-solid fa-briefcase" className="h-full">
            {vacancies.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 h-full">
                    {vacancies.map(job => (
                        <div key={job.id} className="p-4 bg-slate-800/30 rounded-sm border border-slate-700 flex flex-col justify-between h-full">
                            <div>
                                <h4 className="font-bold text-white text-sm mb-1">{job.title}</h4>
                                <p className="text-[10px] text-sky-400 uppercase font-bold tracking-wider mb-2">{job.department}</p>
                                <p className="text-xs text-slate-400 line-clamp-2">{job.description}</p>
                            </div>
                            <button onClick={() => openApplyJobModal(job)} className="mt-3 text-xs bg-slate-700 hover:bg-slate-600 text-white py-1.5 rounded-sm transition-colors w-full uppercase font-bold">Apply</button>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="flex items-center justify-center h-full text-slate-500 italic text-xs">No vacancies listed.</div>
            )}
        </DashboardCard>
    );
};

const ClientMissionTracker: React.FC<{ request: HydratedServiceRequest }> = ({ request }) => {
    const { viewRequestDetails } = useNavigation();

    const steps = [
        { status: ServiceRequestStatus.Submitted, label: 'Submitted', icon: 'fa-paper-plane' },
        { status: ServiceRequestStatus.Triaged, label: 'Accepted', icon: 'fa-clipboard-check' },
        { status: ServiceRequestStatus.Accepted, label: 'Assigned', icon: 'fa-user-group' },
        { status: ServiceRequestStatus.InProgress, label: 'En Route', icon: 'fa-jet-fighter' },
    ];

    const currentStepIndex = steps.findIndex(s => s.status === request.status);
    const isCompleted = request.status === ServiceRequestStatus.Success;
    const activeIndex = isCompleted ? 4 : (currentStepIndex === -1 ? 0 : currentStepIndex);

    return (
        <DashboardCard title="Active Mission Status" icon="fa-solid fa-satellite-dish" className="border-sky-500/30 h-full">
            <div className="flex flex-col h-full justify-between gap-6">
                <div>
                    <div className="flex justify-between items-start mb-2">
                        <h2 className="text-2xl font-black text-white">{request.serviceType} Request</h2>
                        <button onClick={() => viewRequestDetails(request)} className="text-xs bg-slate-800 hover:bg-slate-700 text-sky-400 px-3 py-1.5 rounded-sm border border-slate-600 transition-colors">
                            View Details
                        </button>
                    </div>
                    <p className="text-slate-400 text-sm flex items-center gap-2">
                        <i className="fa-solid fa-map-pin text-sky-500"></i> {request.location}
                    </p>
                </div>

                <div className="relative">
                    <div className="absolute top-1/2 left-0 w-full h-1 bg-slate-800 -translate-y-1/2 rounded-full z-0"></div>
                    <div
                        className="absolute top-1/2 left-0 h-1 bg-sky-500 -translate-y-1/2 rounded-full z-0 transition-all duration-1000 ease-out"
                        style={{ width: `${(activeIndex / (steps.length - 1)) * 100}%` }}
                    ></div>

                    <div className="relative z-10 flex justify-between">
                        {steps.map((step, index) => {
                            const isActive = index <= activeIndex;
                            const isCurrent = index === activeIndex;

                            return (
                                <div key={step.label} className="flex flex-col items-center gap-2">
                                    <div className={`w-10 h-10 rounded-full flex items-center justify-center border-4 transition-all duration-500 ${isActive ? 'bg-sky-900 border-sky-500 text-sky-400' : 'bg-slate-900 border-slate-700 text-slate-600'} ${isCurrent ? 'animate-pulse shadow-[0_0_15px_rgba(14,165,233,0.5)]' : ''}`}>
                                        <i className={`fa-solid ${step.icon}`}></i>
                                    </div>
                                    <span className={`text-[10px] font-bold uppercase tracking-wider ${isActive ? 'text-white' : 'text-slate-600'}`}>{step.label}</span>
                                </div>
                            )
                        })}
                    </div>
                </div>

                <div className="bg-sky-900/20 border border-sky-500/20 p-4 rounded-lg flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-sky-500/20 flex items-center justify-center text-sky-400 animate-spin-slow">
                        <i className="fa-solid fa-circle-notch"></i>
                    </div>
                    <div>
                        <p className="text-sky-300 font-bold text-sm">Operatives are coordinating.</p>
                        <p className="text-sky-400/60 text-xs">Please monitor your radio frequency and accept party invites.</p>
                    </div>
                </div>
            </div>
        </DashboardCard>
    );
}

const QuickRequestForm: React.FC = () => {
    const { currentUser } = useAuth();
    const { createRequest } = useRequests();
    const { setActiveView } = useNavigation();
    const { refreshMainState, refreshRequests } = useData();
    const { members } = useMembers();
    const { brandingConfig, heroCardConfig, serviceTypes } = useConfig();

    const activeServiceTypes = useMemo(() => serviceTypes.filter(t => t.isActive), [serviceTypes]);

    const [serviceType, setServiceType] = useState<ServiceType>(activeServiceTypes.length > 0 ? activeServiceTypes[0].name : 'Security');
    const [location, setLocation] = useState('');
    const [description, setDescription] = useState('');
    const [threatLevel, setThreatLevel] = useState<ThreatLevel>(ThreatLevel.None);
    const [tosAgreed, setTosAgreed] = useState(false);
    const [isTosModalOpen, setIsTosModalOpen] = useState(false);

    useEffect(() => {
        refreshMainState();
        refreshRequests();
    }, [refreshMainState, refreshRequests]);

    // Clamp the user-selected service type to a valid option when the loaded
    // list changes. serviceType is editable state used by handleSubmit, so it
    // cannot be purely derived. Adjusting it during render (React's documented
    // pattern) is behavior-equivalent to the old effect: the guard only fires
    // when the current selection is invalid, and re-seeding it to a member of
    // the list makes the guard false on the next render, so this terminates.
    if (activeServiceTypes.length > 0 && !activeServiceTypes.find(t => t.name === serviceType)) {
        setServiceType(activeServiceTypes[0].name);
    }

    const onDutyCount = useMemo(() => members.filter(m => m.isDuty).length, [members]);

    const handleSubmit = useCallback((e: React.FormEvent) => {
        e.preventDefault();
        if (description.trim() && location.trim()) {
            createRequest({
                serviceType,
                location,
                description,
                urgency: UrgencyLevel.Medium,
                threatLevel,
            });
            setActiveView('requests');
        }
    }, [createRequest, setActiveView, serviceType, location, description, threatLevel]);

    if (currentUser && currentUser.reputation <= 10) {
        return (
            <div className="flex flex-col items-center justify-center py-6 text-center space-y-4 animate-fade-in">
                <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center text-red-500 border border-red-500/20 shadow-lg">
                    <i className="fa-solid fa-user-lock text-2xl"></i>
                </div>
                <div>
                    <h3 className="text-white font-bold text-base uppercase tracking-wider">Service Restricted</h3>
                    <p className="text-slate-400 text-xs mt-1 leading-relaxed max-w-[240px] mx-auto">
                        Your reputation standing is too low to initiate automated requests.
                        Please contact {brandingConfig.name || 'Organisation'} command to review your standing.
                    </p>
                </div>
                <a
                    href={heroCardConfig.discordUrl || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] font-black text-red-400 hover:text-white uppercase tracking-[0.2em] flex items-center group transition-colors"
                >
                    <i className="fa-brands fa-discord mr-2 text-sm group-hover:animate-pulse"></i> Request Review
                </a>
            </div>
        );
    }

    if (onDutyCount === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-center p-8 space-y-4 bg-slate-900/50 rounded-lg border border-slate-700/50">
                <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center text-slate-500 mb-2 ring-4 ring-slate-800 shadow-inner">
                    <i className="fa-solid fa-store-slash text-3xl"></i>
                </div>
                <div>
                    <h3 className="text-white font-bold text-xl">Services Unavailable</h3>
                    <p className="text-slate-400 text-sm mt-2 max-w-xs mx-auto leading-relaxed">
                        There are currently no {brandingConfig.name || 'organization'} units on duty.
                        Please check back later or contact us via Discord for assistance.
                    </p>
                </div>
                <a
                    href={heroCardConfig.discordUrl || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-bold text-sky-400 hover:text-white uppercase tracking-widest mt-4 flex items-center"
                >
                    <i className="fa-brands fa-discord mr-2"></i> Contact Command
                </a>
            </div>
        );
    }

    return (
        <>
            <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Service</label>
                        <select value={serviceType} onChange={(e) => setServiceType(e.target.value as ServiceType)} className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2.5 text-white text-sm focus:border-sky-500 outline-hidden">
                            {activeServiceTypes.map(type => (
                                <option key={type.id} value={type.name}>{type.name}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Threat</label>
                        <select value={threatLevel} onChange={(e) => setThreatLevel(e.target.value as ThreatLevel)} className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2.5 text-white text-sm focus:border-sky-500 outline-hidden">
                            {Object.values(ThreatLevel).map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                    </div>
                </div>
                <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Location</label>
                    <LocationInput value={location} onChange={setLocation} />
                </div>
                <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Details</label>
                    <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full bg-slate-800 border border-slate-600 rounded-sm p-2.5 text-white text-sm focus:border-sky-500 outline-hidden resize-none" placeholder="Brief situation report..." required />
                </div>
                <div className="flex items-center gap-2 py-2">
                    <input type="checkbox" id="tos" checked={tosAgreed} onChange={e => setTosAgreed(e.target.checked)} className="rounded-sm bg-slate-700 border-slate-600 text-sky-500 focus:ring-0" />
                    <div className="text-xs text-slate-400">
                        I agree to the
                        <button
                            type="button"
                            onClick={() => setIsTosModalOpen(true)}
                            className="text-sky-400 hover:text-sky-300 ml-1 hover:underline font-bold"
                        >
                            Terms of Service
                        </button>
                    </div>
                </div>
                <button type="submit" disabled={!tosAgreed} className="w-full bg-sky-600 hover:bg-sky-500 text-white font-bold py-3 rounded-sm shadow-lg shadow-sky-900/20 disabled:bg-slate-700 disabled:text-slate-500 transition-all">
                    Submit Request
                </button>
            </form>

            {isTosModalOpen && createPortal(
                <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-200 animate-fade-in p-4">
                    <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
                        <div className="flex justify-between items-center p-5 border-b border-slate-700">
                            <h2 className="text-xl font-bold text-white">Terms of Service</h2>
                            <button onClick={() => setIsTosModalOpen(false)} className="text-slate-400 hover:text-white transition-colors">
                                <i className="fa-solid fa-xmark h-6 w-6"></i>
                            </button>
                        </div>
                        <div className="p-6 overflow-y-auto custom-scrollbar">
                            <div
                                className="prose prose-invert prose-sm max-w-none 
                                prose-headings:text-sky-300 prose-headings:uppercase prose-headings:font-bold
                                prose-p:text-slate-300 prose-li:text-slate-300"
                            >
                                {/* DOMPurify-sanitized, then rendered to React elements via
                                    html-react-parser — no raw HTML injection. */}
                                {parse(DOMPurify.sanitize(brandingConfig.termsOfService || '<p>Terms of Service not configured.</p>'))}
                            </div>
                        </div>
                        <div className="p-5 border-t border-slate-700 bg-slate-900/50 rounded-b-xl flex justify-end">
                            <button
                                onClick={() => setIsTosModalOpen(false)}
                                className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white font-bold rounded-sm text-sm transition-colors"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>,
                document.body
            )}
        </>
    );
}

const StaffDashboard: React.FC<{
    filteredBulletins: IntelBulletin[];
    handleDeleteBulletin: (id: string) => void;
    deletingBulletinId: string | null;
}> = ({ filteredBulletins, handleDeleteBulletin, deletingBulletinId }) => {
    const { hydratedServiceRequests } = useData();
    const { hrJobs } = useHR();
    const { operations, warrants } = useOperations();
    const { currentUser, hasPermission } = useAuth();
    const { setActiveView, viewRequestDetails, viewOperationDetails, setSelectedBulletin } = useNavigation();
    const { setIsCreateModalOpen, setIsAdHocModalOpen, openCreateIntelWindow, setShowCreateBulletinModal, openCreateWarrantModal } = useModalRegistry();

    const userLevel = useMemo(() => currentUser?.clearanceLevel?.level || 0, [currentUser]);
    const userMarkers = useMemo(() => new Set(currentUser?.limitingMarkers?.map(m => m.id) || []), [currentUser]);

    const pendingRequests = useMemo(() =>
        hydratedServiceRequests
            .filter(r => r.status === ServiceRequestStatus.Submitted || r.status === ServiceRequestStatus.Triaged || r.status === ServiceRequestStatus.InProgress)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
        [hydratedServiceRequests]
    );

    const activeOps = useMemo(() =>
        operations
            .filter(op => {
                if (op.status !== OperationStatus.Active && op.status !== OperationStatus.Scheduled) return false;
                if (op.isSpecial || op.ownerId === currentUser?.id || hasPermission('operations:manage')) return true;
                if ((op.clearanceLevel || 0) > userLevel) return false;
                if (op.limitingMarkers && op.limitingMarkers.length > 0) return op.limitingMarkers.every(m => userMarkers.has(m.id));
                return true;
            })
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
        [operations, currentUser, userLevel, userMarkers, hasPermission]
    );

    const activeWarrants = useMemo(() =>
        warrants
            .filter(w => w.status === WarrantStatus.Active || w.status === WarrantStatus.Standing),
        [warrants]
    );

    const openPositions = useMemo(() => hrJobs.filter(j => j.status === JobPostingStatus.Open).length, [hrJobs]);

    const quickActions = useMemo<QuickAction[]>(() => ([
        hasPermission('request:create') && { label: 'New Request', icon: 'fa-plus', accent: 'sky' as const, onClick: () => setIsCreateModalOpen(true) },
        hasPermission('request:create_adhoc') && { label: 'Ad Hoc', icon: 'fa-bolt', accent: 'amber' as const, onClick: () => setIsAdHocModalOpen(true) },
        hasPermission('intel:create') && { label: 'Intel Report', icon: 'fa-file-shield', accent: 'amber' as const, onClick: () => openCreateIntelWindow() },
        hasPermission('intel:view') && { label: 'Bulletin', icon: 'fa-satellite-dish', accent: 'rose' as const, onClick: () => setShowCreateBulletinModal(true) },
        hasPermission('warrant:create') && { label: 'Caution', icon: 'fa-triangle-exclamation', accent: 'rose' as const, onClick: () => openCreateWarrantModal() },
    ].filter(Boolean) as QuickAction[]), [hasPermission, setIsCreateModalOpen, setIsAdHocModalOpen, openCreateIntelWindow, setShowCreateBulletinModal, openCreateWarrantModal]);

    return (
        <div className="space-y-6">
            {/* Hides itself when nothing pending */}
            <AttentionRequiredPanel />

            <DashboardMetrics />

            <QuickActionsBar actions={quickActions} />

            {/* Feature tabs — one panel visible at a time, persists in sessionStorage */}
            <FeatureTabs />
        </div>
    );
};

const DashboardView: React.FC<{ openRateRequestModal: (req: HydratedServiceRequest) => void }> = ({ openRateRequestModal }) => {
    const { currentUser } = useAuth();
    const { hydratedServiceRequests, announcements, isFetching } = useData();
    const { hrApplicants } = useHR();
    const { activeBulletins, deleteBulletin } = useIntel();
    const { setActiveView } = useNavigation();
    const [currentTime, setCurrentTime] = useState(() => new Date());
    const [isApplyModalOpen, setIsApplyModalOpen] = useState(false);

    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 60000);
        return () => clearInterval(timer);
    }, []);

    // Hooks must be called in the same order on every render — keep them above
    // the `if (!currentUser) return null;` guard and reference currentUser via
    // optional chaining within their bodies.
    const isClient = currentUser?.role === UserRole.Client;

    const myApplication = useMemo(() => {
        if (!currentUser) return undefined;
        return hrApplicants.find(a => a.linkedUserId === currentUser.id);
    }, [hrApplicants, currentUser]);

    const greeting = useMemo(() => {
        const hour = currentTime.getHours();
        if (hour < 12) return "Good Morning";
        if (hour < 18) return "Good Afternoon";
        return "Good Evening";
    }, [currentTime]);

    const userMarkers = useMemo(() => new Set(currentUser?.limitingMarkers?.map((m: any) => m.id) || []), [currentUser]);
    const filteredBulletins = useMemo(() => {
        if (isClient || !currentUser) return [];
        return activeBulletins.filter(b => {
            const authorId = (b as any).createdBy?.id || b.createdById;
            if (authorId === currentUser.id) return true;
            const userLevel = currentUser.clearanceLevel?.level || 0;
            if (b.classificationLevel > userLevel) return false;
            if (b.limitingMarkers && b.limitingMarkers.length > 0) {
                return b.limitingMarkers.every(m => userMarkers.has(m.id));
            }
            return true;
        });
    }, [isClient, activeBulletins, currentUser, userMarkers]);

    const [deletingBulletinId, setDeletingBulletinId] = useState<string | null>(null);
    const handleDeleteBulletin = useCallback(async (id: string) => {
        if (!confirm('Delete this bulletin?')) return;
        setDeletingBulletinId(id);
        try { await deleteBulletin(id); } finally { setDeletingBulletinId(null); }
    }, [deleteBulletin]);

    if (!currentUser) return null;

    const activeRequest = isClient ? hydratedServiceRequests.find(r => r.clientId === currentUser.id && [ServiceRequestStatus.Submitted, ServiceRequestStatus.Triaged, ServiceRequestStatus.Accepted, ServiceRequestStatus.InProgress].includes(r.status)) : null;
    const pendingRating = isClient ? hydratedServiceRequests.find(r => r.clientId === currentUser.id && r.status === ServiceRequestStatus.Success && !r.rated) : null;

    const visibleAnnouncements = announcements.filter(announcement => {
        if (!announcement) return false;
        const now = new Date();
        if (announcement.expiryDate && new Date(announcement.expiryDate) < now) {
            return false;
        }
        if (announcement.audience.includes(currentUser.role)) return true;
        // 'Member' audience includes Dispatchers (they are members with extra permissions)
        if (announcement.audience.includes('Member') && currentUser.role === 'Dispatcher') return true;
        return false;
    });

    return (
        <div className="space-y-6 pb-8 animate-fade-in">
            <DashboardHero variant={isClient ? 'client' : 'staff'} />

            {visibleAnnouncements.length > 0 && (
                <div className="space-y-4">
                    {visibleAnnouncements.map(announcement => (
                        <Notice key={announcement.id} announcement={announcement} />
                    ))}
                </div>
            )}

            {isClient && (
                <>
                    {/* Hides itself when nothing pending */}
                    <AttentionRequiredPanel />
                    {/* 3 cards, includes contracts if marketplace enabled */}
                    <ClientDashboardMetrics />
                </>
            )}
            {isClient && (
                <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
                    <div className="xl:col-span-2 space-y-6">
                        {activeRequest ? (
                            <div>
                                <ClientMissionTracker request={activeRequest} />
                            </div>
                        ) : (
                            <DashboardCard title="Initiate Service Request" icon="fa-solid fa-plus" className="border-sky-500/20 shadow-sky-900/10">
                                <div className="flex flex-col gap-6 h-full">
                                    <div className="space-y-4">
                                        <p className="text-slate-300 text-sm leading-relaxed">
                                            Our organisation provides premium protection, rescue, and logistics solutions.
                                            Submit a request to dispatch our nearest available unit.
                                        </p>
                                        <div className="flex gap-4 text-xs font-mono text-slate-500">
                                            <span className="flex items-center"><i className="fa-solid fa-shield-halved mr-2 text-sky-500"></i> Secure</span>
                                            <span className="flex items-center"><i className="fa-solid fa-bolt mr-2 text-yellow-500"></i> Fast</span>
                                            <span className="flex items-center"><i className="fa-solid fa-check-circle mr-2 text-green-500"></i> Reliable</span>
                                        </div>
                                    </div>
                                    <div className="bg-slate-800/50 p-4 rounded-lg border border-slate-700/50 w-full">
                                        <QuickRequestForm />
                                    </div>
                                </div>
                            </DashboardCard>
                        )}

                        {pendingRating && (
                            <div className="bg-amber-500/10 border border-amber-500/30 p-4 rounded-xl flex items-center justify-between animate-fade-in">
                                <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center text-amber-400">
                                        <i className="fa-solid fa-star"></i>
                                    </div>
                                    <div>
                                        <h4 className="text-white font-bold">Feedback Required</h4>
                                        <p className="text-amber-200/60 text-xs">Please rate your recent {pendingRating.serviceType} service.</p>
                                    </div>
                                </div>
                                <button onClick={() => openRateRequestModal(pendingRating)} className="bg-amber-500 hover:bg-amber-400 text-black font-bold px-4 py-2 rounded-sm text-xs uppercase tracking-wide transition-colors">
                                    Rate Now
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="space-y-6">
                        <div className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-5 flex flex-col gap-4">
                            <div className="flex items-center gap-3 mb-1">
                                <div className="w-10 h-10 rounded-lg bg-sky-900/30 flex items-center justify-center text-sky-400 border border-sky-500/20">
                                    <i className="fa-solid fa-users"></i>
                                </div>
                                <div>
                                    <h3 className="font-bold text-white text-sm uppercase tracking-wide">Join Our Organisation</h3>
                                    <p className="text-xs text-slate-400">Become a member of our organisation.</p>
                                </div>
                            </div>

                            {myApplication ? (
                                <div className="bg-slate-900/50 p-3 rounded-sm border border-slate-700/50">
                                    <div className="flex justify-between items-center mb-1">
                                        <span className="text-[10px] font-black uppercase text-slate-500 tracking-wider">Application Status</span>
                                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase border ${myApplication.status === ApplicationStatus.Hired ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                                            myApplication.status === ApplicationStatus.Rejected ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                                                'bg-sky-500/10 text-sky-400 border-sky-500/20'
                                            }`}>
                                            {myApplication.status}
                                        </span>
                                    </div>
                                    <p className="text-xs text-slate-300">File Reference: {myApplication.id.split('-')[0]}</p>
                                </div>
                            ) : (
                                <>
                                    <p className="text-xs text-slate-400 leading-relaxed">
                                        Looking for regular work? Apply to join our roster and gain access to member resources.
                                    </p>
                                    <button
                                        onClick={() => setIsApplyModalOpen(true)}
                                        className="w-full bg-sky-600 hover:bg-sky-500 text-white font-bold py-2.5 rounded-sm text-xs uppercase tracking-widest shadow-lg shadow-sky-900/20 transition-all active:scale-95"
                                    >
                                        Submit Application
                                    </button>
                                </>
                            )}
                        </div>

                        <HeroCard />
                    </div>
                </div>
            )}

            {!isClient && (
                <StaffDashboard
                    filteredBulletins={filteredBulletins}
                    handleDeleteBulletin={handleDeleteBulletin}
                    deletingBulletinId={deletingBulletinId}
                />
            )}

            <ClientApplyModal
                isOpen={isApplyModalOpen}
                onClose={() => setIsApplyModalOpen(false)}
            />
        </div>
    );
}

export default DashboardView;
