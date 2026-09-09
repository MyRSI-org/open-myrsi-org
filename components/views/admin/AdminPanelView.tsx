
import React, { useState, useMemo, Suspense } from 'react';
import { User, UserRole, ServiceRequestStatus } from '../../../types';
import { useAuth } from '../../../contexts/AuthContext';

import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useHR } from '../../../contexts/HRContext';
import ServiceTypeModal from '../../modals/ServiceTypeModal';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import { useNavigation } from '../../../contexts/NavigationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

// Lazy-load all admin tabs — only the active tab's code is downloaded
const AdminUserDetailView = React.lazy(() => import('./AdminUserDetailView'));
const AdminClientDetailView = React.lazy(() => import('./AdminClientDetailView'));
const RoleDetailView = React.lazy(() => import('./RoleDetailView'));
const AnalyticsDashboard = React.lazy(() => import('./AnalyticsDashboard'));
const AdminMemberManagement = React.lazy(() => import('./AdminMemberManagement'));
const ClientManagementTab = React.lazy(() => import('./ClientManagementTab'));
const UnitManagementTab = React.lazy(() => import('./UnitManagementTab'));
const RankManagementTab = React.lazy(() => import('./RankManagementTab'));
const ManagePositionsTab = React.lazy(() => import('../hr/ManagePositionsTab'));
const RolesManagementTab = React.lazy(() => import('./RolesManagementTab'));
const ClearanceManagementTab = React.lazy(() => import('./ClearanceManagementTab'));
const MemberAchievementsTab = React.lazy(() => import('./MemberAchievementsTab'));
const NoticesManagementTab = React.lazy(() => import('./NoticesManagementTab'));
const EAMBroadcastTab = React.lazy(() => import('./EAMBroadcastTab'));
const ExternalToolsManagementTab = React.lazy(() => import('./ExternalToolsManagementTab'));
const ServiceTypesManagementTab = React.lazy(() => import('./ServiceTypesManagementTab'));
const DiscordSettingsTab = React.lazy(() => import('./DiscordSettingsTab'));
const RadioSettingsTab = React.lazy(() => import('./RadioSettingsTab'));
const AIConfigTab = React.lazy(() => import('./AIConfigTab'));
const IntelligenceManagementTab = React.lazy(() => import('./IntelligenceManagementTab'));
const AllianceManagementTab = React.lazy(() => import('./AllianceManagementTab'));
const AppearanceTab = React.lazy(() => import('./AppearanceTab'));
const OrgPublicPageTab = React.lazy(() => import('./OrgPublicPageTab'));
const LegalDocumentsTab = React.lazy(() => import('./LegalDocumentsTab'));
const DatabaseToolsTab = React.lazy(() => import('./DatabaseToolsTab'));
const SecurityAuditTab = React.lazy(() => import('./SecurityAuditTab'));
const BanManagementTab = React.lazy(() => import('./BanManagementTab'));
const WikiToolsTab = React.lazy(() => import('./WikiToolsTab'));
const OrgImportTab = React.lazy(() => import('./OrgImportTab'));
const GovernmentSettingsTab = React.lazy(() => import('./GovernmentSettingsTab'));
const FeaturesSettingsTab = React.lazy(() => import('./FeaturesSettingsTab'));
const MarketplaceAdminTab = React.lazy(() => import('./MarketplaceAdminTab'));
const AdminShipCatalogTab = React.lazy(() => import('./catalog/AdminShipCatalogTab'));
const AdminItemCatalogTab = React.lazy(() => import('./catalog/AdminItemCatalogTab'));
const AdminCommodityCatalogTab = React.lazy(() => import('./catalog/AdminCommodityCatalogTab'));
const AdminLocationCatalogTab = React.lazy(() => import('./catalog/AdminLocationCatalogTab'));

const AdminTabFallback = () => (
    <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-3">
            <i className="fa-solid fa-circle-notch animate-spin text-slate-300 text-2xl"></i>
            <p className="text-slate-400 text-xs font-mono uppercase tracking-widest">Loading Module</p>
        </div>
    </div>
);

const tabGroups = {
    "Dashboard": [
        { id: 'overview', label: 'System Overview', icon: 'fa-solid fa-gauge-high', permission: 'admin:access' },
    ],
    "User Management": [
        { id: 'roster', label: 'Members', icon: 'fa-solid fa-users', permission: 'admin:view:roster' },
        { id: 'clients', label: 'Clients', icon: 'fa-solid fa-address-book', permission: 'admin:view:clients' },
        { id: 'bans', label: 'Bans & Appeals', icon: 'fa-solid fa-user-slash', permission: 'admin:user:ban' },
    ],
    "Organization": [
        { id: 'units', label: 'Units', icon: 'fa-solid fa-sitemap', permission: 'admin:config:units' },
        { id: 'ranks', label: 'Ranks', icon: 'fa-solid fa-chevron-up', permission: 'admin:config:ranks' },
        { id: 'member_roles', label: 'Positions', icon: 'fa-solid fa-briefcase', permission: 'hr:manage:positions' },
        { id: 'permissions', label: 'Roles & Permissions', icon: 'fa-solid fa-key', permission: 'admin:config:roles' },
        { id: 'clearance', label: 'Security & Vetting', icon: 'fa-solid fa-id-badge', permission: 'admin:config:clearance' },
    ],
    "Recognition": [
        { id: 'achievements', label: 'Member Achievements', icon: 'fa-solid fa-medal', permission: 'admin:config:certifications' },
    ],
    "Communications": [
        { id: 'notices', label: 'Announcements', icon: 'fa-solid fa-bullhorn', permission: 'admin:config:notices' },
        { id: 'tools', label: 'External Tools', icon: 'fa-solid fa-toolbox', permission: 'admin:config:tools' },
        { id: 'eam', label: 'EAM Broadcast', icon: 'fa-solid fa-tower-broadcast', permission: 'admin:broadcast:eam' },
    ],
    "Governance": [
        { id: 'government', label: 'Government', icon: 'fa-solid fa-landmark', permission: 'gov:admin' },
    ],
    "Diplomacy": [
        { id: 'alliances', label: 'Alliances', icon: 'fa-solid fa-handshake', permission: 'alliance:manage' },
    ],
    "Marketplace": [
        { id: 'marketplace_admin', label: 'Marketplace', icon: 'fa-solid fa-store', permission: 'marketplace:admin' },
    ],
    "Integrations": [
        { id: 'discord', label: 'Discord', icon: 'fa-brands fa-discord', permission: 'admin:config:discord' },
        { id: 'radio', label: 'Radio', icon: 'fa-solid fa-walkie-talkie', permission: 'admin:config:branding' },
        { id: 'ai', label: 'AI', icon: 'fa-solid fa-microchip', permission: 'admin:config:ai' },
        // anyOf, because this ONE tab fronts two different capabilities: intel feed sources
        // (intel:manage) and API-key management (admin:config:api). Gated on intel:manage alone,
        // the permission literally named "Manage API Keys" had NO route to the only screen that
        // manages API keys, while an intel:manage holder saw the key UI and 403'd on every
        // click. The server gate is unchanged and remains the boundary.
        { id: 'intel_mgmt', label: 'Intel Feeds', icon: 'fa-solid fa-filter', permission: 'intel:manage', anyOf: ['intel:manage', 'admin:config:api'] },
    ],
    "Appearance": [
        { id: 'appearance', label: 'Appearance', icon: 'fa-solid fa-palette', permission: 'admin:config:branding', anyOf: ['admin:config:branding', 'admin:config:theme', 'admin:config:settings', 'admin:config:metadata'] },
        { id: 'public_page', label: 'Public Landing Page', icon: 'fa-solid fa-globe', permission: 'admin:config:branding' },
    ],
    "Policies": [
        { id: 'legal', label: 'Legal Documents', icon: 'fa-solid fa-scale-balanced', permission: 'admin:config:branding' },
    ],
    "Platform": [
        { id: 'features', label: 'Optional Features', icon: 'fa-solid fa-toggle-on', permission: 'admin:config:features' },
        { id: 'service_types', label: 'Service Types', icon: 'fa-solid fa-list-check', permission: 'admin:config:servicetypes' },
    ],
    "Catalogs": [
        { id: 'catalog_ships', label: 'Ship Catalog', icon: 'fa-solid fa-rocket', permission: 'admin:config:catalog' },
        { id: 'catalog_items', label: 'Item Catalog', icon: 'fa-solid fa-box-open', permission: 'admin:config:catalog' },
        { id: 'catalog_commodities', label: 'Commodity Catalog', icon: 'fa-solid fa-flask', permission: 'admin:config:catalog' },
        { id: 'catalog_locations', label: 'Location Catalog', icon: 'fa-solid fa-globe', permission: 'admin:config:catalog' },
    ],
    "Maintenance": [
        // Deliberately the BROAD visibility gate (admin:access), not the high-bar
        // admin:db:destroy the server enforces on every button inside. This tab is the
        // org's break-glass: repairDatabase re-syncs the Admin role's permissions and
        // lifts an unliftable ban on an Admin (liftBansOnSystemAdmins), and gating the
        // route to it on a permission that only Repair itself can grant is the
        // circularity that manufactures the lockout. The server gate is the boundary —
        // assertAdminRoleFresh + admin:db:destroy — so a broad tab costs a 403, while a
        // narrow one can cost the org its recovery path.
        { id: 'db_tools', label: 'Database Tools', icon: 'fa-solid fa-server', permission: 'admin:access' },
        { id: 'security_audit', label: 'Security Audit', icon: 'fa-solid fa-shield-halved', permission: 'admin:security:view_audit' },
        { id: 'wiki_tools', label: 'Wiki Export/Import', icon: 'fa-solid fa-book', permission: 'admin:access' },
        { id: 'org_import', label: 'Import Organization', icon: 'fa-solid fa-database', permission: 'admin:access' },
    ],
};

const NavigationItem: React.FC<{ id: string; label: string; icon: string; isActive: boolean; onClick: () => void }> = ({ label, icon, isActive, onClick }) => (
    <button
        onClick={onClick}
        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all duration-150 ${isActive
            ? 'bg-slate-700/40 text-slate-100 border border-slate-600 shadow-xs'
            : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-300 border border-transparent'
            }`}
    >
        <i className={`${icon} w-4 text-center text-[10px]`}></i>
        <span className="truncate">{label}</span>
    </button>
);

const AdminPanelView: React.FC = () => {
    const { hasPermission } = useAuth();
    // A tab is visible if the caller holds its permission, or ANY of an optional
    // anyOf set (used by the consolidated Appearance tab, which fronts several
    // sub-permissions).
    const canSeeTab = (tab: { permission: string; anyOf?: readonly string[] }) =>
        tab.anyOf ? tab.anyOf.some(p => hasPermission(p)) : hasPermission(tab.permission);
    const { editingServiceType } = useNavigation();
    const { openAdjustReputationModal, openReputationHistoryModal, openRatingHistoryModal, openAwardSingleCertModal, openAwardSingleCommendModal, openAddConductEntryModal, isServiceTypeModalOpen, setIsServiceTypeModalOpen } = useModalRegistry();
    const { hydratedServiceRequests } = useData();
    const { allUsers } = useMembers();
    const { hrApplicants } = useHR();
    const [activeTab, setActiveTab] = useState('overview');
    const [managingUserId, setManagingUserId] = useState<number | null>(null);
    const [managingRoleId, setManagingRoleId] = useState<number | null>(null);

    // Derive managingUser from allUsers so it stays in sync with data changes
    const managingUser = managingUserId ? allUsers.find(u => u.id === managingUserId) || null : null;

    // Hero stats
    const heroStats = useMemo(() => {
        const members = allUsers.filter(u => u.role !== UserRole.Client).length;
        const activeRequests = hydratedServiceRequests.filter(r => r.status === ServiceRequestStatus.Submitted || r.status === ServiceRequestStatus.InProgress || r.status === ServiceRequestStatus.Accepted).length;
        const openCases = (hrApplicants || []).filter(a => ['Applied', 'Screening', 'Interviewing', 'OnHold', 'Offered'].includes(a.status as string)).length;
        const dutyNow = allUsers.filter(u => u.isDuty && u.role !== UserRole.Client).length;
        return { members, activeRequests, openCases, dutyNow };
    }, [allUsers, hydratedServiceRequests, hrApplicants]);

    const handleTabClick = (tabId: string) => {
        setActiveTab(tabId);
        setManagingUserId(null);
        setManagingRoleId(null);
    };

    const setManagingUser = (user: User | null) => setManagingUserId(user?.id ?? null);

    const renderContent = () => {
        if (managingUser) {
            if (managingUser.role === UserRole.Client) {
                return <AdminClientDetailView
                    user={managingUser}
                    onBack={() => setManagingUserId(null)}
                    openAdjustReputationModal={openAdjustReputationModal}
                    openReputationHistoryModal={openReputationHistoryModal}
                />;
            }
            return <AdminUserDetailView
                user={managingUser}
                onBack={() => setManagingUserId(null)}
                openReputationHistoryModal={openReputationHistoryModal}
                openRatingHistoryModal={openRatingHistoryModal}
                openAdjustReputationModal={openAdjustReputationModal}
                openAwardSingleCertModal={openAwardSingleCertModal}
                openAwardSingleCommendModal={openAwardSingleCommendModal}
                openAddConductEntryModal={openAddConductEntryModal}
            />;
        }

        if (managingRoleId) {
            return <RoleDetailView roleId={managingRoleId} onBack={() => setManagingRoleId(null)} />;
        }

        switch (activeTab) {
            case 'overview': return <AnalyticsDashboard />;
            case 'roster': return hasPermission('admin:view:roster') ? <AdminMemberManagement onManageUser={setManagingUser} scrollId="admin-roster-list" /> : null;
            case 'clients': return hasPermission('admin:view:clients') ? <ClientManagementTab onManageUser={setManagingUser} /> : null;
            case 'bans': return hasPermission('admin:user:ban') ? <BanManagementTab /> : null;
            case 'units': return hasPermission('admin:config:units') ? <UnitManagementTab /> : null;
            case 'ranks': return hasPermission('admin:config:ranks') ? <RankManagementTab /> : null;
            case 'member_roles': return hasPermission('hr:manage:positions') ? <div className="p-8"><ManagePositionsTab /></div> : null;
            case 'permissions': return hasPermission('admin:config:roles') ? <RolesManagementTab onSelectRole={setManagingRoleId} /> : null;
            case 'clearance': return hasPermission('admin:config:clearance') ? <ClearanceManagementTab /> : null;
            case 'achievements': return hasPermission('admin:config:certifications') ? <MemberAchievementsTab /> : null;
            case 'notices': return hasPermission('admin:config:notices') ? <NoticesManagementTab /> : null;
            case 'tools': return hasPermission('admin:config:tools') ? <ExternalToolsManagementTab /> : null;
            case 'eam': return hasPermission('admin:broadcast:eam') ? <EAMBroadcastTab /> : null;
            case 'discord': return hasPermission('admin:config:discord') ? <DiscordSettingsTab /> : null;
            case 'appearance': return <AppearanceTab />;
            case 'public_page': return hasPermission('admin:config:branding') ? <OrgPublicPageTab /> : null;
            case 'legal': return hasPermission('admin:config:branding') ? <LegalDocumentsTab /> : null;
            case 'radio': return hasPermission('admin:config:branding') ? <RadioSettingsTab /> : null;
            case 'ai': return hasPermission('admin:config:ai') ? <AIConfigTab /> : null;
            case 'intel_mgmt': return (hasPermission('intel:manage') || hasPermission('admin:config:api')) ? <IntelligenceManagementTab /> : null;
            case 'alliances': return hasPermission('alliance:manage') ? <AllianceManagementTab /> : null;
            case 'marketplace_admin': return hasPermission('marketplace:admin') ? <MarketplaceAdminTab /> : null;
            case 'government': return hasPermission('gov:admin') ? <GovernmentSettingsTab /> : null;
            case 'features': return hasPermission('admin:config:features') ? <FeaturesSettingsTab /> : null;
            case 'db_tools': return hasPermission('admin:access') ? <DatabaseToolsTab /> : null;
            case 'security_audit': return hasPermission('admin:security:view_audit') ? <SecurityAuditTab /> : null;
            case 'wiki_tools': return hasPermission('admin:access') ? <WikiToolsTab /> : null;
            case 'org_import': return hasPermission('admin:access') ? <OrgImportTab /> : null;
            case 'service_types': return hasPermission('admin:config:servicetypes') ? <ServiceTypesManagementTab /> : null;
            case 'catalog_ships': return hasPermission('admin:config:catalog') ? <AdminShipCatalogTab /> : null;
            case 'catalog_items': return hasPermission('admin:config:catalog') ? <AdminItemCatalogTab /> : null;
            case 'catalog_commodities': return hasPermission('admin:config:catalog') ? <AdminCommodityCatalogTab /> : null;
            case 'catalog_locations': return hasPermission('admin:config:catalog') ? <AdminLocationCatalogTab /> : null;
            default: return <AnalyticsDashboard />;
        }
    };

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel="MODULE · ADMIN CONSOLE"
                chipIcon="fa-screwdriver-wrench"
                chipAccent="slate"
                title="Admin Console"
                subtitle="Organization configuration, users, integrations, and maintenance."
                stats={<>
                    <HeroStat icon="fa-users" label="Members" value={heroStats.members} accent="sky" />
                    <HeroStat icon="fa-tower-broadcast" label="Active Requests" value={heroStats.activeRequests} accent="amber" emphasize={heroStats.activeRequests > 0} />
                    <HeroStat icon="fa-folder-open" label="Open Cases" value={heroStats.openCases} accent="emerald" emphasize={heroStats.openCases > 0} />
                    <HeroStat icon="fa-bolt" label="On Duty" value={heroStats.dutyNow} accent="emerald" emphasize={heroStats.dutyNow > 0} />
                </>}
            />

            {/* Body */}
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
                {/* Mobile nav */}
                <div className="lg:hidden shrink-0 px-4 py-3 border-b border-slate-800/60 bg-slate-900/50">
                    <div className="relative">
                        <select
                            value={activeTab}
                            onChange={(e) => setActiveTab(e.target.value)}
                            className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-4 py-3 text-sm font-bold text-white focus:ring-1 focus:ring-slate-400/50 focus:border-slate-500 outline-hidden appearance-none transition-all"
                        >
                            {Object.entries(tabGroups).map(([categoryName, tabs]) => {
                                const visibleTabs = tabs.filter(canSeeTab);
                                if (visibleTabs.length === 0) return null;
                                return (
                                    <optgroup key={categoryName} label={categoryName} className="bg-slate-900 text-slate-400">
                                        {visibleTabs.map(tab => (
                                            <option key={tab.id} value={tab.id} className="text-white">{tab.label}</option>
                                        ))}
                                    </optgroup>
                                );
                            })}
                        </select>
                        <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-slate-400">
                            <i className="fa-solid fa-chevron-down text-xs"></i>
                        </div>
                    </div>
                </div>

                {/* Desktop sidebar */}
                <div className="hidden lg:flex flex-col shrink-0 w-60 border-r border-slate-800/60 bg-slate-900/40 overflow-y-auto custom-scrollbar py-5 px-3 gap-5">
                    {Object.entries(tabGroups).map(([categoryName, tabs]) => {
                        const visibleTabs = tabs.filter(canSeeTab);
                        if (visibleTabs.length === 0) return null;
                        return (
                            <div key={categoryName} className="space-y-0.5">
                                <p className="px-3 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-1.5">{categoryName}</p>
                                {visibleTabs.map(tab => (
                                    <NavigationItem
                                        key={tab.id}
                                        id={tab.id}
                                        label={tab.label}
                                        icon={tab.icon}
                                        isActive={activeTab === tab.id}
                                        onClick={() => handleTabClick(tab.id)}
                                    />
                                ))}
                            </div>
                        );
                    })}
                </div>

                {/* Content */}
                <div
                    id="admin-content-container"
                    className="flex-1 min-h-0 min-w-0 overflow-y-auto custom-scrollbar"
                >
                    <Suspense fallback={<AdminTabFallback />}>
                        {renderContent()}
                    </Suspense>
                </div>
            </div>

            <ServiceTypeModal
                isOpen={isServiceTypeModalOpen}
                onClose={() => setIsServiceTypeModalOpen(false)}
                config={editingServiceType}
            />
        </div>
    );
};

export default AdminPanelView;
