
import React, { useEffect, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';
import { useConfig } from '../../contexts/ConfigContext';
import { useGovernment } from '../../contexts/GovernmentContext';

import { usePWAInstall } from '../../hooks/usePWAInstall';
import { useSidebarGroups } from '../../hooks/useSidebarGroups';
import SidebarGroup from './SidebarGroup';
import { useNavigation } from '../../contexts/NavigationContext';
import { useModalRegistry } from '../../contexts/ModalRegistryContext';

interface SidebarProps {
    activeView: string;
    setActiveView: (view: string) => void;
    isSidebarCollapsed: boolean;
    setIsSidebarCollapsed: (collapsed: boolean) => void;
    isMobileOpen: boolean;
    setIsMobileOpen: (isOpen: boolean) => void;
}

export const NavItem: React.FC<{
    icon: React.ReactNode;
    label: string;
    isActive: boolean;
    onClick: () => void;
    isCollapsed: boolean;
    isMobile: boolean;
}> = ({ icon, label, isActive, onClick, isCollapsed, isMobile }) => (
    <button
        onClick={onClick}
        title={isCollapsed && !isMobile ? label : undefined}
        className={`flex items-center w-full py-3.5 my-0.5 text-left text-sm font-medium rounded-r-full transition-all duration-200 ease-in-out border-l-4 group
      ${(isCollapsed && !isMobile) ? 'px-0 justify-center' : 'px-5'}
      ${isActive
                ? 'bg-sky-500/10 text-sky-400 border-sky-500'
                : 'text-slate-400 border-transparent hover:bg-white/5 hover:text-slate-200 hover:border-slate-600'
            }
    `}
    >
        <div className={`transition-transform duration-200 ${isActive ? 'scale-110' : 'group-hover:scale-110'} shrink-0`}>
            {icon}
        </div>
        {(!isCollapsed || isMobile) && <span className="ml-4 tracking-wide truncate">{label}</span>}
    </button>
);

const Sidebar: React.FC<SidebarProps> = ({
    activeView,
    setActiveView,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    isMobileOpen,
    setIsMobileOpen
}) => {
    const { currentUser, hasPermission, idleTime, toggleDutyStatus } = useAuth();
    const { orgMeta } = useData();
    const { allUsers } = useMembers();
    const { brandingConfig } = useConfig();
    const { governmentsFeatureConfig } = useGovernment();
    const governmentsEnabled = governmentsFeatureConfig?.enabled || false;
    const financesEnabled = (orgMeta?.features?.finances?.enabled) === true;
    const quartermasterEnabled = (orgMeta?.features?.quartermaster?.enabled) === true;
    const warehouseEnabled = (orgMeta?.features?.warehouse?.enabled) === true;
    const marketplaceEnabled = (orgMeta?.features?.marketplace?.enabled) === true;
    // Leaderboard and External Tools default ON — absent means enabled.
    const leaderboardEnabled = (orgMeta?.features?.leaderboard?.enabled) !== false;
    const externalToolsEnabled = (orgMeta?.features?.externalTools?.enabled) !== false;
    const { isTogglingDuty } = useNavigation();
    const { openIssueEamModal } = useModalRegistry();
    const { canInstall, isInstalled, promptInstall } = usePWAInstall();
    const { isExpanded, toggle, ensureExpanded } = useSidebarGroups();

    // Map active views → group ids so we can auto-expand the group housing
    // the current view on mount (stops users from hunting for "where am I?").
    const activeGroupId = useMemo(() => {
        const v = activeView;
        if (['dashboard', 'requests', 'request-detail', 'dispatch', 'operations', 'operation-detail', 'warrants', 'intel'].includes(v)) return 'command';
        if (['roster', 'member-record', 'leaderboard', 'hr', 'applicant-detail', 'security-vetting', 'case-file-detail', 'internal-transfer-detail', 'internal-job-detail', 'fleet', 'government'].includes(v)) return 'org';
        if (['finances', 'quartermaster', 'warehouse', 'marketplace'].includes(v)) return 'economy';
        if (['wiki', 'external-tools', 'radio-control'].includes(v)) return 'resources';
        if (['profile', 'help', 'admin'].includes(v)) return 'system';
        return null;
    }, [activeView]);

    useEffect(() => {
        if (activeGroupId) ensureExpanded(activeGroupId);
    }, [activeGroupId, ensureExpanded]);

    // Default expand state per group (used when localStorage has no record yet).
    const DEFAULT_EXPAND: Record<string, boolean> = {
        command: true,
        org: true,
        economy: false,
        resources: false,
        system: false,
    };

    const liveUser = useMemo(() => {
        if (!currentUser) return null;
        return allUsers.find(u => u.id === currentUser.id) || currentUser;
    }, [allUsers, currentUser]);

    if (!currentUser || !liveUser) return null;

    const handleNavClick = (view: string) => {
        setActiveView(view);
        setIsMobileOpen(false);
    };

    const dutyTimeoutMins = brandingConfig.dutyTimeoutMinutes || 30;
    const showIdleWarning = liveUser.isDuty && idleTime > 300;
    const minsRemaining = Math.max(0, Math.floor(dutyTimeoutMins - (idleTime / 60)));

    return (
        <>
            <div
                className={`fixed inset-0 bg-black/80 backdrop-blur-xs z-90 lg:hidden transition-opacity duration-300 ${isMobileOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                    }`}
                onClick={() => setIsMobileOpen(false)}
            />

            <aside
                className={`
            fixed top-0 bottom-0 left-0 z-100
            lg:static lg:z-auto
            flex flex-col bg-slate-950/80 backdrop-blur-xl border-r border-slate-800
            transition-all duration-300 ease-in-out
            ${isMobileOpen ? 'translate-x-0 shadow-2xl shadow-black' : '-translate-x-full lg:translate-x-0 lg:shadow-none'}
            ${isSidebarCollapsed ? 'lg:w-20' : 'lg:w-72'}
            w-72
        `}
            >
                <div className="flex flex-col h-full">
                    <div className={`flex flex-col items-start justify-center h-28 border-b border-white/5 shrink-0 bg-slate-900/50 relative transition-all duration-300 ${isSidebarCollapsed && !isMobileOpen ? 'px-0 items-center' : 'px-6'}`}>
                        <div className={`flex items-center w-full ${isSidebarCollapsed && !isMobileOpen ? 'justify-center' : 'justify-start space-x-4'}`}>
                            <div className="shrink-0 flex items-center justify-center">
                                <img
                                    src={brandingConfig?.iconUrl}
                                    alt="Logo"
                                    className={`transition-all duration-300 object-contain ${isSidebarCollapsed && !isMobileOpen ? 'h-8 w-8' : 'h-10 w-10'}`}
                                />
                            </div>
                            {(!isSidebarCollapsed || isMobileOpen) && (
                                <div className="flex flex-col min-w-0 overflow-hidden text-left">
                                    <span className="text-lg font-black text-white tracking-widest leading-none uppercase truncate">{brandingConfig?.name || 'ORG'}</span>
                                    <span className="text-[10px] text-sky-500 tracking-[0.3em] font-bold uppercase mt-0.5 truncate">Terminal</span>
                                </div>
                            )}
                        </div>

                        <button
                            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                            className={`hidden lg:flex text-slate-500 hover:text-white transition-colors mt-4 p-1 rounded-sm hover:bg-slate-800 ${isSidebarCollapsed ? 'self-center' : 'self-end absolute bottom-2 right-4'}`}
                            title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
                        >
                            <i className={`fa-solid ${isSidebarCollapsed ? 'fa-angles-right' : 'fa-angles-left'}`}></i>
                        </button>
                    </div>

                    <button
                        onClick={() => setIsMobileOpen(false)}
                        className="absolute top-6 right-4 text-slate-500 hover:text-white lg:hidden p-2"
                    >
                        <i className="fa-solid fa-xmark text-xl"></i>
                    </button>

                    <div className="flex-1 py-6 overflow-y-auto overflow-x-hidden custom-scrollbar text-left">
                        {(() => {
                            // In collapsed-rail mode on desktop, skip groups and render a flat icon list
                            // (groups don't help when only icons are showing). Mobile drawer keeps groups.
                            const useGroups = !isSidebarCollapsed || isMobileOpen;

                            // Build each item with its permission/feature guard. Only rendered items
                            // count toward a group's visibility; empty groups auto-hide.
                            const dashboard = (
                                <NavItem
                                    icon={<i className="fa-solid fa-house fa-fw"></i>}
                                    label="Dashboard"
                                    isActive={activeView === 'dashboard'}
                                    onClick={() => handleNavClick('dashboard')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            );
                            const serviceRequests = (
                                <NavItem
                                    icon={<i className="fa-solid fa-list-ul fa-fw"></i>}
                                    label="Service Requests"
                                    isActive={activeView === 'requests' || activeView === 'request-detail'}
                                    onClick={() => handleNavClick('requests')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            );
                            const dispatchConsole = hasPermission('request:dispatch') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-headset fa-fw"></i>}
                                    label="Dispatch Console"
                                    isActive={activeView === 'dispatch'}
                                    onClick={() => handleNavClick('dispatch')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const operations = hasPermission('operations:view') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-sitemap fa-fw"></i>}
                                    label="Operations Center"
                                    isActive={activeView === 'operations' || activeView === 'operation-detail'}
                                    onClick={() => handleNavClick('operations')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const warrants = hasPermission('warrant:view') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-bullseye fa-fw"></i>}
                                    label="Caution Notes"
                                    isActive={activeView === 'warrants'}
                                    onClick={() => handleNavClick('warrants')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const intel = (hasPermission('intel:view') || hasPermission('intel:create')) ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-eye fa-fw"></i>}
                                    label="Intelligence Hub"
                                    isActive={activeView === 'intel'}
                                    onClick={() => handleNavClick('intel')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const alliances = hasPermission('alliance:view') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-handshake fa-fw"></i>}
                                    label="Alliances"
                                    isActive={activeView === 'alliances'}
                                    onClick={() => handleNavClick('alliances')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const dutyRoster = hasPermission('user:toggle_duty') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-users fa-fw"></i>}
                                    label="Duty Roster"
                                    isActive={activeView === 'roster' || activeView === 'member-record'}
                                    onClick={() => handleNavClick('roster')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            // Org Chart — top-level browsing surface for all units. Shares
                            // the user:view:roster gate with Duty Roster so anyone who can see
                            // members can also see the org structure.
                            const orgChart = hasPermission('user:view:roster') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-sitemap fa-fw"></i>}
                                    label="Org Chart"
                                    isActive={activeView === 'org-chart' || activeView === 'unit-detail'}
                                    onClick={() => handleNavClick('org-chart')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const leaderboard = (hasPermission('user:toggle_duty') && leaderboardEnabled) ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-trophy fa-fw"></i>}
                                    label="Leaderboard"
                                    isActive={activeView === 'leaderboard'}
                                    onClick={() => handleNavClick('leaderboard')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const hr = hasPermission('hr:view') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-people-group fa-fw"></i>}
                                    label="HR Hub"
                                    isActive={activeView === 'hr' || activeView === 'applicant-detail' || activeView === 'security-vetting' || activeView === 'case-file-detail'}
                                    onClick={() => handleNavClick('hr')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const fleet = hasPermission('fleet:view') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-rocket fa-fw"></i>}
                                    label="Fleet Manager"
                                    isActive={activeView === 'fleet'}
                                    onClick={() => handleNavClick('fleet')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const government = (hasPermission('gov:view') && governmentsEnabled) ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-landmark fa-fw"></i>}
                                    label="Government"
                                    isActive={activeView === 'government'}
                                    onClick={() => handleNavClick('government')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const finances = (hasPermission('finance:view') && financesEnabled) ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-vault fa-fw"></i>}
                                    label="Finances"
                                    isActive={activeView === 'finances'}
                                    onClick={() => handleNavClick('finances')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const quartermaster = (hasPermission('qm:view') && quartermasterEnabled) ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-warehouse fa-fw"></i>}
                                    label="Quartermaster"
                                    isActive={activeView === 'quartermaster'}
                                    onClick={() => handleNavClick('quartermaster')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const warehouse = (hasPermission('warehouse:view') && warehouseEnabled) ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-boxes-stacked fa-fw"></i>}
                                    label="Warehouse"
                                    isActive={activeView === 'warehouse'}
                                    onClick={() => handleNavClick('warehouse')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const marketplace = (hasPermission('marketplace:view') && marketplaceEnabled) ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-store fa-fw"></i>}
                                    label="Marketplace"
                                    isActive={activeView === 'marketplace'}
                                    onClick={() => handleNavClick('marketplace')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const wiki = hasPermission('wiki:view') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-book fa-fw"></i>}
                                    label="Org Wiki"
                                    isActive={activeView === 'wiki'}
                                    onClick={() => handleNavClick('wiki')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const externalTools = (hasPermission('user:toggle_duty') && externalToolsEnabled) ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-toolbox fa-fw"></i>}
                                    label="External Tools"
                                    isActive={activeView === 'external-tools'}
                                    onClick={() => handleNavClick('external-tools')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const radio = hasPermission('radio:manage') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-tower-broadcast fa-fw"></i>}
                                    label="Radio Control"
                                    isActive={activeView === 'radio-control'}
                                    onClick={() => handleNavClick('radio-control')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;
                            const profile = (
                                <NavItem
                                    icon={<i className="fa-solid fa-id-card fa-fw"></i>}
                                    label="My Account"
                                    isActive={activeView === 'profile'}
                                    onClick={() => handleNavClick('profile')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            );
                            const help = (
                                <NavItem
                                    icon={<i className="fa-solid fa-circle-question fa-fw"></i>}
                                    label="Help & Docs"
                                    isActive={activeView === 'help'}
                                    onClick={() => handleNavClick('help')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            );
                            const admin = hasPermission('admin:access') ? (
                                <NavItem
                                    icon={<i className="fa-solid fa-screwdriver-wrench fa-fw"></i>}
                                    label="Admin Console"
                                    isActive={activeView === 'admin'}
                                    onClick={() => handleNavClick('admin')}
                                    isCollapsed={isSidebarCollapsed}
                                    isMobile={isMobileOpen}
                                />
                            ) : null;

                            // Group membership
                            const commandItems = [dashboard, serviceRequests, dispatchConsole, operations, warrants, intel].filter(Boolean);
                            const orgItems = [dutyRoster, orgChart, leaderboard, hr, fleet, government, alliances].filter(Boolean);
                            const economyItems = [finances, quartermaster, warehouse, marketplace].filter(Boolean);
                            const resourcesItems = [wiki, externalTools, radio].filter(Boolean);
                            const systemItems = [profile, help, admin].filter(Boolean);

                            // Collapsed rail: flat list, no group chrome
                            if (!useGroups) {
                                return (
                                    <nav className="space-y-1">
                                        {commandItems}
                                        {orgItems.length > 0 && <div className="my-4 border-t border-white/5 mx-4" />}
                                        {orgItems}
                                        {economyItems.length > 0 && <div className="my-4 border-t border-white/5 mx-4" />}
                                        {economyItems}
                                        {resourcesItems.length > 0 && <div className="my-4 border-t border-white/5 mx-4" />}
                                        {resourcesItems}
                                        <div className="my-4 border-t border-white/5 mx-4" />
                                        {systemItems}
                                    </nav>
                                );
                            }

                            // Expanded: grouped collapsible sections
                            return (
                                <nav className="px-2">
                                    <SidebarGroup
                                        id="command" label="Command & Ops" icon="fa-satellite-dish" accent="sky"
                                        expanded={isExpanded('command', DEFAULT_EXPAND.command)}
                                        onToggle={() => toggle('command', DEFAULT_EXPAND.command)}
                                        hidden={commandItems.length === 0}
                                    >
                                        {commandItems}
                                    </SidebarGroup>
                                    <SidebarGroup
                                        id="org" label="Org Management" icon="fa-people-group" accent="indigo"
                                        expanded={isExpanded('org', DEFAULT_EXPAND.org)}
                                        onToggle={() => toggle('org', DEFAULT_EXPAND.org)}
                                        hidden={orgItems.length === 0}
                                    >
                                        {orgItems}
                                    </SidebarGroup>
                                    <SidebarGroup
                                        id="economy" label="Economy" icon="fa-coins" accent="amber"
                                        expanded={isExpanded('economy', DEFAULT_EXPAND.economy)}
                                        onToggle={() => toggle('economy', DEFAULT_EXPAND.economy)}
                                        hidden={economyItems.length === 0}
                                    >
                                        {economyItems}
                                    </SidebarGroup>
                                    <SidebarGroup
                                        id="resources" label="Resources" icon="fa-toolbox" accent="slate"
                                        expanded={isExpanded('resources', DEFAULT_EXPAND.resources)}
                                        onToggle={() => toggle('resources', DEFAULT_EXPAND.resources)}
                                        hidden={resourcesItems.length === 0}
                                    >
                                        {resourcesItems}
                                    </SidebarGroup>
                                    <SidebarGroup
                                        id="system" label="System" icon="fa-gear" accent="slate"
                                        expanded={isExpanded('system', DEFAULT_EXPAND.system)}
                                        onToggle={() => toggle('system', DEFAULT_EXPAND.system)}
                                        hidden={systemItems.length === 0}
                                    >
                                        {systemItems}
                                    </SidebarGroup>
                                </nav>
                            );
                        })()}
                    </div>

                    <div className="shrink-0 p-4 border-t border-white/5 bg-slate-900/50 space-y-3">

                        {hasPermission('admin:broadcast:eam') && (
                            <button
                                onClick={openIssueEamModal}
                                className={`w-full relative overflow-hidden font-black uppercase tracking-widest transition-all duration-300 group
                            bg-red-900/20 text-red-500 border border-red-500/30 hover:bg-red-900/40 hover:border-red-500
                            ${isSidebarCollapsed && !isMobileOpen ? 'h-10 w-10 rounded-xl flex items-center justify-center mx-auto' : 'py-3 px-4 rounded-lg text-[10px]'}
                        `}
                                title="ISSUE EAM"
                            >
                                <span className="relative z-10 flex items-center justify-center gap-2">
                                    <i className="fa-solid fa-radiation"></i>
                                    {(!isSidebarCollapsed || isMobileOpen) && 'ISSUE EAM'}
                                </span>
                            </button>
                        )}

                        {hasPermission('user:toggle_duty') && (
                            <div className="">
                                {(!isSidebarCollapsed || isMobileOpen) && (
                                    <p className="text-[10px] uppercase font-black text-slate-500 mb-2 tracking-wider text-center">Status Control</p>
                                )}
                                <button
                                    onClick={() => toggleDutyStatus(currentUser.id)}
                                    disabled={isTogglingDuty}
                                    className={`w-full relative overflow-hidden font-bold transition-all duration-300 group
                            ${liveUser.isDuty
                                            ? 'bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 hover:border-green-500/40'
                                            : 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:border-red-500/40'
                                        } 
                            ${isSidebarCollapsed && !isMobileOpen ? 'h-10 w-10 rounded-xl flex items-center justify-center mx-auto' : 'py-3 px-4 rounded-lg text-xs uppercase tracking-widest'}`}
                                    title={liveUser.isDuty ? "Go Off Duty" : "Go On Duty"}
                                >
                                    <span className="relative z-10 flex items-center justify-center gap-2 text-center">
                                        {isTogglingDuty ? (
                                            <>
                                                <i className="fa-solid fa-circle-notch animate-spin"></i>
                                                {(!isSidebarCollapsed || isMobileOpen) && 'UPDATING...'}
                                            </>
                                        ) : (
                                            <>
                                                <i className="fa-solid fa-power-off"></i>
                                                {(!isSidebarCollapsed || isMobileOpen) && (liveUser.isDuty ? 'ON DUTY' : 'OFF DUTY')}
                                            </>
                                        )}
                                    </span>
                                    {liveUser.isDuty && !isTogglingDuty && (
                                        <span className="absolute inset-0 bg-green-400/5 animate-pulse rounded-lg"></span>
                                    )}
                                </button>
                                {showIdleWarning && (!isSidebarCollapsed || isMobileOpen) && (
                                    <p className="text-[9px] text-amber-500 text-center mt-2 font-mono uppercase animate-pulse">
                                        Idle Timeout: {minsRemaining}m
                                    </p>
                                )}
                            </div>
                        )}

                        {canInstall && !isInstalled && (
                            <button
                                onClick={promptInstall}
                                className={`w-full relative overflow-hidden font-bold transition-all duration-300
                                    bg-sky-500/10 text-sky-400 border border-sky-500/20 hover:bg-sky-500/20 hover:border-sky-500/40
                                    ${isSidebarCollapsed && !isMobileOpen ? 'h-10 w-10 rounded-xl flex items-center justify-center mx-auto' : 'py-2.5 px-4 rounded-lg text-[10px] uppercase tracking-widest'}`}
                                title="Install App"
                            >
                                <span className="flex items-center justify-center gap-2">
                                    <i className="fa-solid fa-download"></i>
                                    {(!isSidebarCollapsed || isMobileOpen) && 'Install App'}
                                </span>
                            </button>
                        )}

                        {(!isSidebarCollapsed || isMobileOpen) && (
                            <div className="text-center">
                                <button onClick={() => handleNavClick('changelog')} className="text-[10px] text-slate-600 hover:text-sky-500 transition-colors font-mono">
                                    v15.1.2-open (STABLE)
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </aside>
        </>
    );
};

export default Sidebar;
