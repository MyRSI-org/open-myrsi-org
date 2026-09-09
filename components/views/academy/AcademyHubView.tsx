import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useAcademy } from '../../../contexts/AcademyContext';
import { useData } from '../../../contexts/DataContext';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import { CatalogTab, MyLearningTab } from './AcademyStudentTabs';
import { CourseBuilderTab, SessionsTab } from './AcademyInstructorTabs';
import { ApprovalsTab, CertifyTab } from './AcademyManagerTabs';
import { ReportsTab } from './AcademyReportsTab';

type AcademyTab = 'catalog' | 'my-learning' | 'courses' | 'sessions' | 'approvals' | 'certify' | 'reports';

const NavigationItem: React.FC<{ label: string; icon: string; isActive: boolean; onClick: () => void; badge?: number }> = ({ label, icon, isActive, onClick, badge }) => (
    <button
        onClick={onClick}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all duration-150 ${isActive
            ? 'bg-purple-500/15 text-purple-300 border border-purple-500/30 shadow-xs shadow-purple-900/20'
            : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-300 border border-transparent'
            }`}
    >
        <i className={`${icon} w-4 text-center text-[10px]`}></i>
        <span className="truncate flex-1 text-left">{label}</span>
        {badge != null && badge > 0 && (
            <span className="min-w-[18px] h-[18px] px-1.5 text-[10px] font-bold rounded-full flex items-center justify-center bg-amber-500/20 text-amber-300">{badge}</span>
        )}
    </button>
);

const AcademyHubView: React.FC = () => {
    const { hasPermission } = useAuth();
    const { academyCourses, academyMyEnrollments, refreshAcademy, refreshMyAcademy } = useAcademy();
    const { isFetching } = useData();

    const canInstruct = hasPermission('academy:instruct');
    const canManage = hasPermission('academy:manage');
    const canViewStaff = hasPermission('academy:view') || canInstruct || canManage;

    // Students always load their own bundle; staff also load the management bundle.
    useEffect(() => { void refreshMyAcademy(); }, [refreshMyAcademy]);
    useEffect(() => { if (canViewStaff) void refreshAcademy(); }, [canViewStaff, refreshAcademy]);

    const [activeTab, setActiveTab] = useState<AcademyTab>(() => {
        if (typeof window !== 'undefined') return (localStorage.getItem('academy_active_tab') as AcademyTab) || 'catalog';
        return 'catalog';
    });
    useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('academy_active_tab', activeTab); }, [activeTab]);

    const stats = useMemo(() => {
        const myActive = academyMyEnrollments.filter(e => e.status === 'enrolled' || e.status === 'in_progress').length;
        const myCompleted = academyMyEnrollments.filter(e => e.status === 'completed').length;
        const pendingApprovals = academyCourses.filter(c => c.status === 'pending_approval').length;
        const publishedCourses = academyCourses.filter(c => c.status === 'published').length;
        return { myActive, myCompleted, pendingApprovals, publishedCourses };
    }, [academyMyEnrollments, academyCourses]);

    const navGroups = useMemo(() => {
        const groups: Array<{ title: string; items: Array<{ id: AcademyTab; label: string; icon: string; badge?: number }> }> = [
            {
                title: 'My Academy',
                items: [
                    { id: 'catalog', label: 'Course Catalog', icon: 'fa-solid fa-book-open-reader' },
                    { id: 'my-learning', label: 'My Learning', icon: 'fa-solid fa-user-graduate', badge: stats.myActive },
                ],
            },
        ];
        if (canInstruct || canManage) {
            groups.push({
                title: 'Instructor',
                items: [
                    { id: 'courses', label: 'Course Builder', icon: 'fa-solid fa-chalkboard-user' },
                    { id: 'sessions', label: 'Sessions & Rosters', icon: 'fa-solid fa-users-rectangle' },
                ],
            });
        }
        if (canManage) {
            groups.push({
                title: 'Learning Managers',
                items: [
                    { id: 'approvals', label: 'Approvals', icon: 'fa-solid fa-clipboard-check', badge: stats.pendingApprovals },
                    { id: 'certify', label: 'Certify', icon: 'fa-solid fa-user-graduate' },
                    { id: 'reports', label: 'Reports', icon: 'fa-solid fa-chart-line' },
                ],
            });
        }
        return groups;
    }, [canInstruct, canManage, stats.myActive, stats.pendingApprovals]);

    // If the active tab isn't available to this user, fall back to the catalog.
    const allTabIds = navGroups.flatMap(g => g.items.map(i => i.id));
    const effectiveTab = allTabIds.includes(activeTab) ? activeTab : 'catalog';

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · ACADEMY"
                chipIcon="fa-graduation-cap"
                chipAccent="purple"
                title="Academy"
                subtitle="Courses, cohort sessions, and competency-based certification for your organisation."
                syncing={isFetching['academy'] || isFetching['academy_my']}
                stats={<>
                    <HeroStat icon="fa-user-graduate" label="My Active" value={stats.myActive} accent="purple" emphasize={stats.myActive > 0} onClick={() => setActiveTab('my-learning')} />
                    <HeroStat icon="fa-certificate" label="My Completed" value={stats.myCompleted} accent="emerald" />
                    <HeroStat icon="fa-book-open" label="Published" value={stats.publishedCourses} accent="sky" onClick={() => setActiveTab('catalog')} />
                    {canManage && <HeroStat icon="fa-clipboard-check" label="Awaiting Approval" value={stats.pendingApprovals} accent="amber" emphasize={stats.pendingApprovals > 0} onClick={() => setActiveTab('approvals')} />}
                </>}
            />

            <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
                {/* Mobile nav */}
                <div className="lg:hidden shrink-0 px-4 py-3 border-b border-slate-800/60 bg-slate-900/50">
                    <select
                        value={effectiveTab}
                        onChange={(e) => setActiveTab(e.target.value as AcademyTab)}
                        className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-3 text-sm font-bold text-white focus:ring-1 focus:ring-purple-500/50 outline-hidden appearance-none"
                    >
                        {navGroups.map(group => (
                            <optgroup key={group.title} label={group.title} className="bg-slate-900 text-slate-400">
                                {group.items.map(item => <option key={item.id} value={item.id} className="text-white">{item.label}</option>)}
                            </optgroup>
                        ))}
                    </select>
                </div>

                {/* Desktop sidebar */}
                <div className="hidden lg:flex flex-col shrink-0 w-60 border-r border-slate-800/60 bg-slate-900/40 overflow-y-auto custom-scrollbar py-5 px-3 gap-5">
                    {navGroups.map(group => (
                        <div key={group.title} className="space-y-0.5">
                            <p className="px-3 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1.5">{group.title}</p>
                            {group.items.map(item => (
                                <NavigationItem key={item.id} label={item.label} icon={item.icon} isActive={effectiveTab === item.id} onClick={() => setActiveTab(item.id)} badge={item.badge} />
                            ))}
                        </div>
                    ))}
                </div>

                {/* Content */}
                <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden custom-scrollbar p-4 sm:p-6">
                    {effectiveTab === 'catalog' && <CatalogTab />}
                    {effectiveTab === 'my-learning' && <MyLearningTab />}
                    {effectiveTab === 'courses' && (canInstruct || canManage) && <CourseBuilderTab canManage={canManage} />}
                    {effectiveTab === 'sessions' && (canInstruct || canManage) && <SessionsTab canManage={canManage} />}
                    {effectiveTab === 'approvals' && canManage && <ApprovalsTab />}
                    {effectiveTab === 'certify' && canManage && <CertifyTab />}
                    {effectiveTab === 'reports' && canManage && <ReportsTab />}
                </div>
            </div>
        </div>
    );
};

export default AcademyHubView;
