
import React, { useState, useEffect, useMemo } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useHR } from '../../../contexts/HRContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useNow } from '../../../hooks/useNow';
import { ApplicationStatus, JobPostingStatus } from '../../../types';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';

import OverviewTab from './OverviewTab';
import GazetteTab from './GazetteTab';
import MyApplicationsTab from './MyApplicationsTab';
import MyTransfersTab from './MyTransfersTab';
import MySpecializationsTab from './MySpecializationsTab';
import MyOperationsTab from './MyOperationsTab';
import MyServiceHistoryTab from './MyServiceHistoryTab';
import MyConductTab from './MyConductTab';
import MyCommendationsTab from './MyCommendationsTab';
import MyCertificationsTab from './MyCertificationsTab';
import MyClearancesTab from './MyClearancesTab';
import ATSTab from './ATSTab';
import MyInterviewsTab from './MyInterviewsTab';
import ManageInterviewsTab from './ManageInterviewsTab';
import HRNoticesTab from './HRNoticesTab';
import ManagePositionsTab from './ManagePositionsTab';
import HRMembersTab from './HRMembersTab';
import HRClientRegisterTab from './HRClientRegisterTab';
import MyUnitView from './MyUnitView';
import ProbationTab from './ProbationTab';

import AdminJobsTab from '../admin/AdminJobsTab';
import AdminTemplatesTab from '../admin/AdminTemplatesTab';

type HRTab =
    // Self Service
    'overview' | 'my-posting' | 'my-unit' | 'my-clearance' | 'my-specializations' | 'my-applications' |
    // My Organisation
    'gazette' | 'notices' |
    // Service History
    'ops-log' | 'responder-log' | 'my-conduct' | 'my-commendations' | 'my-certifications' |
    // HR Management
    'case-management' | 'manage-members' | 'client-register' | 'my-interviews' | 'manage-interviews' | 'manage-vacancy' | 'manage-templates' | 'manage-positions' | 'probation';

const NavigationItem: React.FC<{ id: HRTab; label: string; icon: string; isActive: boolean; onClick: () => void; badge?: number; urgent?: boolean }> = ({ label, icon, isActive, onClick, badge, urgent }) => (
    <button
        onClick={onClick}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all duration-150 ${isActive
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-xs shadow-emerald-900/20'
                : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-300 border border-transparent'
            }`}
    >
        <i className={`${icon} w-4 text-center text-[10px]`}></i>
        <span className="truncate flex-1 text-left">{label}</span>
        {badge != null && badge > 0 && (
            <span className={`min-w-[18px] h-[18px] px-1.5 text-[10px] font-bold rounded-full flex items-center justify-center ${urgent ? 'bg-amber-500/20 text-amber-300 animate-pulse' : 'bg-emerald-500/20 text-emerald-300'}`}>
                {badge}
            </span>
        )}
    </button>
);

const HRHubView: React.FC = () => {
    const { hasPermission } = useAuth();
    const { refreshHR, isFetching } = useData();
    const { members } = useMembers();
    const { hrApplicants, hrInterviews, hrJobs } = useHR();
    const now = useNow();

    useEffect(() => {
        refreshHR();
    }, [refreshHR]);

    const [activeTab, setActiveTab] = useState<HRTab>(() => {
        if (typeof window !== 'undefined') {
            const saved = localStorage.getItem('hr_active_tab') as HRTab;
            if (saved === 'case-file-detail' as any) return 'overview';
            return saved || 'overview';
        }
        return 'overview';
    });
    // Lifted from HRMembersTab so the "Manage Members" nav item can reset
    // the detail-view drill-in even when the user is already on that tab.
    const [managingMemberId, setManagingMemberId] = useState<number | null>(null);
    // Lifted from HRClientRegisterTab so the "Client Register" nav item can
    // reset the drill-in. Same pattern as managingMemberId.
    const [managingClientId, setManagingClientId] = useState<number | null>(null);

    // Wraps tab navigation so clicking "Manage Members" / "Client Register"
    // always lands on the list, even when drilled into a detail view.
    const handleNavTo = (tab: HRTab) => {
        if (tab === 'manage-members') setManagingMemberId(null);
        if (tab === 'client-register') setManagingClientId(null);
        setActiveTab(tab);
    };

    const canRecruit = hasPermission('hr:recruiter');
    const canManageJobs = hasPermission('hr:manager');
    const canAdminHR = hasPermission('hr:admin');
    const canManagePositions = canManageJobs || canAdminHR;

    // Listen for external navigation events
    useEffect(() => {
        const handleNavigationEvent = (e: CustomEvent) => {
            const requestedTab = e.detail as HRTab;
            if (requestedTab) {
                let target = requestedTab;
                if (requestedTab === 'ats' as any) target = 'case-management';
                if (target !== ('case-file-detail' as any)) {
                    setActiveTab(target);
                }
            }
        };

        window.addEventListener('app:navigate-hr-tab', handleNavigationEvent as EventListener);
        return () => window.removeEventListener('app:navigate-hr-tab', handleNavigationEvent as EventListener);
    }, []);

    useEffect(() => {
        if (typeof window !== 'undefined' && activeTab !== ('case-file-detail' as any)) {
            localStorage.setItem('hr_active_tab', activeTab);
        }
    }, [activeTab]);

    // Hero stats
    const heroStats = useMemo(() => {
        const inFlightStatuses = new Set<ApplicationStatus>([
            ApplicationStatus.Applied,
            ApplicationStatus.Screening,
            ApplicationStatus.Interviewing,
            ApplicationStatus.OnHold,
            ApplicationStatus.Offered,
        ]);
        const openCases = hrApplicants.filter(a => inFlightStatuses.has(a.status as ApplicationStatus)).length;
        const pendingInterviews = hrInterviews.filter(i => i.scheduledAt && new Date(i.scheduledAt).getTime() > now && i.status !== 'Completed').length;
        const openVacancies = hrJobs.filter(j => (j.status as JobPostingStatus) === JobPostingStatus.Open).length;
        const probationTracked = members.filter((m: any) => m.probationEnd).length;
        return { openCases, pendingInterviews, openVacancies, probationTracked };
    }, [hrApplicants, hrInterviews, hrJobs, members, now]);

    const navGroups = useMemo(() => {
        type NavItem = { id: HRTab; label: string; icon: string; badge?: number; urgent?: boolean };
        type NavGroup = { title: string; items: NavItem[] };
        const groups: NavGroup[] = [
            {
                title: "Self Service",
                items: [
                    { id: 'overview' as HRTab, label: 'My Career', icon: 'fa-solid fa-id-badge' },
                    { id: 'my-unit' as HRTab, label: 'My Unit', icon: 'fa-solid fa-shield-cat' },
                    { id: 'my-posting' as HRTab, label: 'My Posting', icon: 'fa-solid fa-map-location-dot' },
                    { id: 'my-clearance' as HRTab, label: 'My Clearance', icon: 'fa-solid fa-user-shield' },
                    { id: 'my-specializations' as HRTab, label: 'My Specialisations', icon: 'fa-solid fa-tags' },
                    { id: 'my-applications' as HRTab, label: 'My Applications', icon: 'fa-solid fa-file-signature' },
                ]
            },
            {
                title: "My Organisation",
                items: [
                    { id: 'gazette' as HRTab, label: 'Job Gazette', icon: 'fa-solid fa-newspaper', badge: heroStats.openVacancies > 0 ? heroStats.openVacancies : undefined },
                    { id: 'notices' as HRTab, label: 'Notices', icon: 'fa-solid fa-bullhorn' },
                ]
            },
            {
                title: "Service History",
                items: [
                    { id: 'ops-log' as HRTab, label: 'Operations Log', icon: 'fa-solid fa-person-military-rifle' },
                    { id: 'responder-log' as HRTab, label: 'Responder Log', icon: 'fa-solid fa-truck-medical' },
                    { id: 'my-conduct' as HRTab, label: 'Conduct Record', icon: 'fa-solid fa-gavel' },
                    { id: 'my-commendations' as HRTab, label: 'Commendations', icon: 'fa-solid fa-medal' },
                    { id: 'my-certifications' as HRTab, label: 'Certifications', icon: 'fa-solid fa-certificate' },
                ]
            }
        ];

        if (canRecruit || canManageJobs || canAdminHR) {
            const hrItems: Array<{ id: HRTab; label: string; icon: string; badge?: number; urgent?: boolean }> = [];

            if (canRecruit || canAdminHR) {
                hrItems.push({ id: 'case-management' as HRTab, label: 'Case Management', icon: 'fa-solid fa-folder-tree', badge: heroStats.openCases > 0 ? heroStats.openCases : undefined });
                hrItems.push({ id: 'manage-members' as HRTab, label: 'Manage Members', icon: 'fa-solid fa-users-viewfinder' });
                hrItems.push({ id: 'client-register' as HRTab, label: 'Client Register', icon: 'fa-solid fa-address-book' });
                hrItems.push({ id: 'probation' as HRTab, label: 'Probation Tracker', icon: 'fa-solid fa-hourglass-half', badge: heroStats.probationTracked > 0 ? heroStats.probationTracked : undefined });

                hrItems.push({ id: 'my-interviews' as HRTab, label: 'My Interviews', icon: 'fa-solid fa-clipboard-user' });
                hrItems.push({ id: 'manage-interviews' as HRTab, label: 'Manage Interviews', icon: 'fa-solid fa-calendar-check', badge: heroStats.pendingInterviews > 0 ? heroStats.pendingInterviews : undefined });
            }

            if (canManageJobs || canAdminHR) {
                hrItems.push({ id: 'manage-vacancy' as HRTab, label: 'Manage Vacancy', icon: 'fa-solid fa-pen-to-square' });
            }

            if (canManagePositions) {
                hrItems.push({ id: 'manage-positions' as HRTab, label: 'Manage Roles / Positions', icon: 'fa-solid fa-briefcase' });
            }

            if (canAdminHR) {
                hrItems.push({ id: 'manage-templates' as HRTab, label: 'Interview Templates', icon: 'fa-solid fa-clipboard-question' });
            }

            groups.push({ title: "HR Management", items: hrItems });
        }
        return groups;
    }, [canRecruit, canManageJobs, canAdminHR, canManagePositions, heroStats]);

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · HR HUB"
                chipIcon="fa-id-badge"
                chipAccent="emerald"
                title="HR Hub"
                subtitle="Personnel records, recruitment, interviews, transfers, and clearance management."
                syncing={isFetching['hr']}
                stats={<>
                    <HeroStat icon="fa-folder-tree" label="Open Cases" value={heroStats.openCases} accent="emerald" emphasize={heroStats.openCases > 0} onClick={(canRecruit || canAdminHR) ? () => setActiveTab('case-management') : undefined} />
                    <HeroStat icon="fa-calendar-check" label="Pending Interviews" value={heroStats.pendingInterviews} accent="amber" emphasize={heroStats.pendingInterviews > 0} onClick={(canRecruit || canAdminHR) ? () => setActiveTab('manage-interviews') : undefined} />
                    <HeroStat icon="fa-newspaper" label="Open Vacancies" value={heroStats.openVacancies} accent="sky" emphasize={heroStats.openVacancies > 0} onClick={() => setActiveTab('gazette')} />
                    <HeroStat icon="fa-hourglass-half" label="Probation" value={heroStats.probationTracked} accent="purple" emphasize={heroStats.probationTracked > 0} onClick={(canRecruit || canAdminHR) ? () => setActiveTab('probation') : undefined} />
                </>}
            />

            {/* Body */}
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
                {/* Mobile nav */}
                <div className="lg:hidden shrink-0 px-4 py-3 border-b border-slate-800/60 bg-slate-900/50">
                    <div className="relative">
                        <select
                            value={activeTab}
                            onChange={(e) => handleNavTo(e.target.value as HRTab)}
                            className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-3 text-sm font-bold text-white focus:ring-1 focus:ring-emerald-500/50 focus:border-emerald-500/40 outline-hidden appearance-none transition-all"
                        >
                            {navGroups.map((group) => (
                                <optgroup key={group.title} label={group.title} className="bg-slate-900 text-slate-400">
                                    {group.items.map(item => (
                                        <option key={item.id} value={item.id} className="text-white">{item.label}</option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-emerald-300">
                            <i className="fa-solid fa-chevron-down text-xs"></i>
                        </div>
                    </div>
                </div>

                {/* Desktop sidebar */}
                <div className="hidden lg:flex flex-col shrink-0 w-60 border-r border-slate-800/60 bg-slate-900/40 overflow-y-auto custom-scrollbar py-5 px-3 gap-5">
                    {navGroups.map((group) => (
                        <div key={group.title} className="space-y-0.5">
                            <p className="px-3 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1.5">{group.title}</p>
                            {group.items.map(item => (
                                <NavigationItem
                                    key={item.id}
                                    id={item.id}
                                    label={item.label}
                                    icon={item.icon}
                                    isActive={activeTab === item.id}
                                    onClick={() => handleNavTo(item.id)}
                                    badge={(item as any).badge}
                                    urgent={(item as any).urgent}
                                />
                            ))}
                        </div>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden custom-scrollbar p-4 sm:p-6">
                    {activeTab === 'overview' && <OverviewTab setActiveTab={(t) => setActiveTab(t as HRTab)} />}
                    {activeTab === 'my-unit' && <MyUnitView />}
                    {activeTab === 'my-posting' && <MyTransfersTab />}
                    {activeTab === 'my-clearance' && <MyClearancesTab />}
                    {activeTab === 'my-specializations' && <MySpecializationsTab />}
                    {activeTab === 'my-applications' && <MyApplicationsTab />}

                    {activeTab === 'gazette' && <GazetteTab />}
                    {activeTab === 'notices' && <HRNoticesTab />}

                    {activeTab === 'ops-log' && <MyOperationsTab />}
                    {activeTab === 'responder-log' && <MyServiceHistoryTab />}
                    {activeTab === 'my-conduct' && <MyConductTab />}
                    {activeTab === 'my-commendations' && <MyCommendationsTab />}
                    {activeTab === 'my-certifications' && <MyCertificationsTab />}

                    {activeTab === 'case-management' && <ATSTab />}
                    {activeTab === 'manage-members' && <HRMembersTab managingUserId={managingMemberId} setManagingUserId={setManagingMemberId} />}
                    {activeTab === 'client-register' && <HRClientRegisterTab managingClientId={managingClientId} setManagingClientId={setManagingClientId} />}
                    {activeTab === 'probation' && <ProbationTab />}
                    {activeTab === 'my-interviews' && <MyInterviewsTab />}
                    {activeTab === 'manage-interviews' && <ManageInterviewsTab />}
                    {activeTab === 'manage-vacancy' && <AdminJobsTab />}
                    {activeTab === 'manage-templates' && <AdminTemplatesTab />}
                    {activeTab === 'manage-positions' && <ManagePositionsTab />}
                </div>
            </div>
        </div>
    );
};

export default HRHubView;
