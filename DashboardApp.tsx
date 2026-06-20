
import React, { useMemo, useEffect, useRef, Suspense, useState } from 'react';
import BootSplash from './components/shared/BootSplash';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { DataProvider, useData } from './contexts/DataContext';
import { DataCoreProvider } from './contexts/DataCoreContext';
import { MembersProvider } from './contexts/MembersContext';
import { ConfigProvider } from './contexts/ConfigContext';
import { OperationsProvider } from './contexts/OperationsContext';
import { IntelProvider, useIntel } from './contexts/IntelContext';
import { HRProvider } from './contexts/HRContext';
import { WarehouseProvider } from './contexts/WarehouseContext';
import { FleetProvider } from './contexts/FleetContext';
import { GovernmentProvider } from './contexts/GovernmentContext';
import { RequestsProvider } from './contexts/RequestsContext';
import { AnnouncementsProvider } from './contexts/AnnouncementsContext';
import { UIProvider, useUI } from './contexts/UIContext';
import { RadioProvider } from './contexts/RadioContext';
import { HIDPTTProvider } from './contexts/HIDPTTContext';
import { HydratedServiceRequest } from './types';
import Sidebar from './components/layout/Sidebar';
import Header from './components/layout/Header';
import CreateRequestModal from './components/modals/CreateRequestModal';
import CompleteRequestModal from './components/modals/CompleteRequestModal';
import AddResponderModal from './components/modals/AddResponderModal';
import CreateAdHocRequestModal from './components/modals/CreateAdHocRequestModal';
import UpdateRequestModal from './components/modals/UpdateRequestModal';
import AdjustReputationModal from './components/modals/AdjustReputationModal';
import BulkAssignClearanceModal from './components/modals/BulkAssignClearanceModal';
import UnitModal from './components/modals/UnitModal';
import RankModal from './components/modals/RankModal';
import NoticeModal from './components/modals/NoticeModal';
import LoginView from './components/views/auth/LoginView';
const OrgPublicPage = React.lazy(() => import('./components/public/OrgPublicPage'));
const OnboardingWizard = React.lazy(() => import('./components/views/onboarding/OnboardingWizard'));
import TriageRequestModal from './components/modals/TriageRequestModal';
import FirstTimeSetupView from './components/views/auth/FirstTimeSetupView';
import NewUserSetupView from './components/views/auth/NewUserSetupView';
import DispatchModal from './components/modals/DispatchModal';
import EamModal from './components/modals/EamModal';
import OperationAlertModal from './components/modals/OperationAlertModal';
import IssueEamModal from './components/modals/IssueEamModal';
import ReputationHistoryModal from './components/modals/ReputationHistoryModal';
import RatingHistoryModal from './components/modals/RatingHistoryModal';
import DeleteAccountModal from './components/modals/DeleteAccountModal';
import RsiVerificationRequiredView from './components/views/auth/RsiVerificationRequiredView';
import AwardSingleCertificationModal from './components/modals/AwardSingleCertificationModal';
import AwardSingleCommendationModal from './components/modals/AwardSingleCommendationModal';
import AddConductEntryModal from './components/modals/AddConductEntryModal';
import CreateOperationWizard from './components/modals/CreateOperationWizard';
import OperationTemplatesModal from './components/modals/OperationTemplatesModal';
import TeamModal from './components/modals/TeamModal';
import PositionModal from './components/modals/PositionModal';
import CreateWarrantModal from './components/modals/CreateWarrantModal';
import UpdateWarrantModal from './components/modals/UpdateWarrantStatusModal';
import ExternalToolModal from './components/modals/ExternalToolModal';
import RoleModal from './components/modals/RoleModal';
import LocationModal from './components/modals/LocationModal';
import RateRequestModal from './components/modals/RateRequestModal';
import SyncUsersModal from './components/modals/SyncUsersModal';
import ScheduleInterviewModal from './components/modals/hr/ScheduleInterviewModal';
import ConductInterviewModal from './components/modals/hr/ConductInterviewModal';
import CreateJobModal from './components/modals/hr/CreateJobModal';
import CreateTemplateModal from './components/modals/hr/CreateTemplateModal';
import CreateTransferModal from './components/modals/hr/CreateTransferModal';
import CreatePositionModal from './components/modals/hr/CreatePositionModal';
import AddProspectModal from './components/modals/hr/AddProspectModal';
import AddCaseFileModal from './components/modals/hr/AddCaseFileModal';
import ApplyJobModal from './components/modals/hr/ApplyJobModal';
import ManageSpecializationsModal from './components/modals/ManageSpecializationsModal';
import RequestClearanceModal from './components/modals/RequestClearanceModal';
import CaseDetailsModal from './components/modals/hr/CaseDetailsModal';
const WikiView = lazyWithRetry(() => import('./components/views/wiki/WikiView'));
import ConfirmDialog from './components/modals/ConfirmDialog';
import CreateIntelReportModal from './components/modals/CreateIntelReportModal';
import IntelReportDetailModal from './components/modals/IntelReportDetailModal';
import CreateBulletinModal from './components/modals/CreateBulletinModal';
import WarrantDetailModal from './components/modals/WarrantDetailModal';
import BulletinDetailModal from './components/modals/BulletinDetailModal';
import RadioOverlay from './components/ui/RadioOverlay';
import RadioWidget from './components/ui/RadioWidget';
import WindowTaskbar from './components/layout/WindowTaskbar';
import NotificationListener from './components/utility/NotificationListener';
import { initializeSupabase } from './lib/supabaseClient';
import { ErrorBoundary } from './components/utility/ErrorBoundary';

// Retry wrapper for lazy view imports — handles transient preload failures
// (e.g. Safari module preload quirks) and stale-chunk errors after deploys.
// Retry once after 1.5s; if that also fails, force a full page reload (once)
// so the browser fetches the new index.html with correct chunk references.
function lazyWithRetry(importFn: () => Promise<any>) {
    return React.lazy(() =>
        importFn().catch(() => {
            return new Promise<void>(resolve => setTimeout(resolve, 1500))
                .then(() => importFn())
                .catch(() => {
                    const reloadKey = 'chunk-reload-' + location.pathname;
                    if (!sessionStorage.getItem(reloadKey)) {
                        sessionStorage.setItem(reloadKey, '1');
                        window.location.reload();
                    }
                    // If we already reloaded once for this path, surface the error
                    return Promise.reject(new Error('Failed to load page module after retry and reload.'));
                });
        })
    );
}

// Lazy Load Views
const DashboardView = lazyWithRetry(() => import('./components/views/operations/DashboardView'));
const ServiceRequestsView = lazyWithRetry(() => import('./components/views/operations/ServiceRequestsView'));
const DutyRosterView = lazyWithRetry(() => import('./components/views/personnel/DutyRosterView'));
const OrganisationView = lazyWithRetry(() => import('./components/views/organisation/OrganisationView'));
const UnitDetailView = lazyWithRetry(() => import('./components/views/personnel/UnitDetailView'));
const AdminPanelView = lazyWithRetry(() => import('./components/views/admin/AdminPanelView'));
const ProfileView = lazyWithRetry(() => import('./components/views/personnel/ProfileView'));
const MyServiceRecordView = lazyWithRetry(() => import('./components/views/personnel/MyServiceRecordView'));
const ServiceRequestDetailView = lazyWithRetry(() => import('./components/views/operations/ServiceRequestDetailView'));
const LeaderboardView = lazyWithRetry(() => import('./components/views/personnel/LeaderboardView'));
const HelpView = lazyWithRetry(() => import('./components/views/help/HelpView'));
const TermsOfServiceView = lazyWithRetry(() => import('./components/views/help/TermsOfServiceView'));
const ChangeLogView = lazyWithRetry(() => import('./components/views/help/ChangeLogView'));
const OperationsCenterView = lazyWithRetry(() => import('./components/views/operations/OperationsCenterView'));
const OperationDetailView = lazyWithRetry(() => import('./components/views/operations/OperationDetailView'));
const WarrantsView = lazyWithRetry(() => import('./components/views/operations/WarrantsView'));
const ExternalToolsView = lazyWithRetry(() => import('./components/views/tools/ExternalToolsView'));
const RadioControlView = lazyWithRetry(() => import('./components/views/tools/RadioControlView'));
const DispatchCenterView = lazyWithRetry(() => import('./components/views/operations/DispatchCenterView'));
const IntelligenceView = lazyWithRetry(() => import('./components/views/intel/IntelligenceView'));
const AllianceDirectoryView = lazyWithRetry(() => import('./components/views/alliances/AllianceDirectoryView'));
const MirroredOperationDetailView = lazyWithRetry(() => import('./components/views/operations/MirroredOperationDetailView'));
const HRHubView = lazyWithRetry(() => import('./components/views/hr/HRHubView'));
const ApplicantDetailView = lazyWithRetry(() => import('./components/views/hr/ApplicantDetailView'));
const SecurityVettingView = lazyWithRetry(() => import('./components/views/hr/SecurityVettingView'));
const UnifiedCaseFileView = lazyWithRetry(() => import('./components/views/hr/UnifiedCaseFileView'));
const InternalTransferView = lazyWithRetry(() => import('./components/views/hr/InternalTransferView'));
const InternalJobView = lazyWithRetry(() => import('./components/views/hr/InternalJobView'));
const SearchCenterView = lazyWithRetry(() => import('./components/views/tools/SearchCenterView'));
const FleetManagerView = lazyWithRetry(() => import('./components/views/fleet/FleetManagerView'));
const GovernmentView = lazyWithRetry(() => import('./components/views/government/GovernmentView'));
const FinancesView = lazyWithRetry(() => import('./components/views/finances/FinancesView'));
const QuartermasterView = lazyWithRetry(() => import('./components/views/quartermaster/QuartermasterView'));
const WarehouseView = lazyWithRetry(() => import('./components/views/warehouse/WarehouseView'));
const MarketplaceView = lazyWithRetry(() => import('./components/views/marketplace/MarketplaceView'));

const LoadingFallback = () => (
    <div className="flex items-center justify-center h-64">
        <div className="text-center space-y-4">
            <div className="relative inline-block">
                <div className="absolute inset-0 bg-sky-500 blur-2xl opacity-10 rounded-full animate-pulse"></div>
                <i className="fa-solid fa-circle-notch animate-spin text-sky-500 text-3xl relative z-10"></i>
            </div>
            <div>
                <p className="text-slate-400 text-sm font-mono uppercase tracking-widest">Loading Module</p>
                <div className="w-24 h-0.5 bg-slate-800 rounded-full mx-auto mt-3 overflow-hidden">
                    <div className="h-full bg-sky-500/50 rounded-full animate-pulse" style={{ width: '60%' }}></div>
                </div>
            </div>
        </div>
    </div>
);

const PushNotificationBanner = () => {
    const { subscribeToPush, isPushActive } = useAuth();
    const [dismissed, setDismissed] = useState(() => {
        return localStorage.getItem('push_banner_dismissed') === 'true';
    });

    if (isPushActive || dismissed) return null;
    if (!('Notification' in window) || Notification.permission === 'denied') return null;

    const handleDismiss = () => {
        localStorage.setItem('push_banner_dismissed', 'true');
        setDismissed(true);
    };

    const handleSubscribe = () => {
        subscribeToPush();
    };

    return (
        <div className="fixed bottom-0 left-0 right-0 bg-sky-900/90 backdrop-blur-xl border-t border-sky-500/50 p-4 z-150 flex flex-col sm:flex-row justify-between items-center gap-4 animate-fade-in-up shadow-2xl">
            <div className="flex items-center gap-4">
                <div className="p-3 bg-sky-500/20 rounded-full text-sky-400 border border-sky-500/30">
                    <i className="fa-solid fa-satellite-dish"></i>
                </div>
                <div>
                    <h3 className="font-bold text-white text-sm uppercase tracking-wide">Secure Comms Available</h3>
                    <p className="text-xs text-sky-200/70">Enable push notifications to receive mission alerts while off-duty.</p>
                </div>
            </div>
            <div className="flex gap-3">
                <button onClick={handleDismiss} className="text-xs font-bold text-slate-400 hover:text-white px-4 py-2 uppercase tracking-wider">Dismiss</button>
                <button onClick={handleSubscribe} className="text-xs font-bold bg-sky-500 hover:bg-sky-400 text-white px-5 py-2 rounded-sm shadow-lg shadow-sky-900/20 transition-all active:scale-95 uppercase tracking-wider">
                    Enable Uplink
                </button>
            </div>
        </div>
    );
};


const AppContent: React.FC = () => {
    const {
        currentUser, pendingUser, isLoadingAuth, isInitialized, needsSetup, setupCompleted, bootResolved,
        authError, clearAuthError,
        handleLogin, handleFinalizeAdminSetup,
        handleNewUserSetup, config,
        orgNotFound,
        slug,
    } = useAuth();
    const { deleteIntelReport } = useIntel();

    const [showExtendedWait, setShowExtendedWait] = useState(false);

    const { brandingConfig, openGraphConfig, hydratedServiceRequests, notifyDbConnected, platformSettings, deleteBulletin, announcements } = useData();
    const {
        activeView, setActiveView, isMobileSidebarOpen, setIsMobileSidebarOpen,
        isSidebarCollapsed, setIsSidebarCollapsed,

        // Modals
        isCreateModalOpen, setIsCreateModalOpen,
        isAdHocModalOpen, setIsAdHocModalOpen,
        isCompleteModalOpen, setIsCompleteModalOpen,
        isAddResponderModalOpen, setIsAddResponderModalOpen,
        isRateRequestModalOpen, setIsRateRequestModalOpen,
        isUpdateRequestModalOpen, setIsUpdateRequestModalOpen,
        isAdjustReputationModalOpen, setIsAdjustReputationModalOpen,
        isBulkAssignClearanceModalOpen, setIsBulkAssignClearanceModalOpen,
        isUnitModalOpen, setIsUnitModalOpen,
        isRankModalOpen, setIsRankModalOpen,
        isNoticeModalOpen, setIsNoticeModalOpen,
        isRoleModalOpen, setIsRoleModalOpen,
        isLocationModalOpen, setIsLocationModalOpen,
        isTriageModalOpen, setIsTriageModalOpen,
        isDispatchModalOpen, setIsDispatchModalOpen,
        isReputationHistoryModalOpen, setIsReputationHistoryModalOpen,
        isRatingHistoryModalOpen, setIsRatingHistoryModalOpen,
        isDeleteAccountModalOpen, setIsDeleteAccountModalOpen,
        isAddConductEntryModalOpen, setIsAddConductEntryModalOpen,
        isAwardSingleCertModalOpen, setIsAwardSingleCertModalOpen,
        isAwardSingleCommendModalOpen, setIsAwardSingleCommendModalOpen,
        isCreateOperationModalOpen, setIsCreateOperationModalOpen,
        isOperationTemplatesModalOpen, setIsOperationTemplatesModalOpen,
        isTeamModalOpen, setIsTeamModalOpen,
        isPositionModalOpen, setIsPositionModalOpen,
        isCreateWarrantModalOpen, setIsCreateWarrantModalOpen,
        isUpdateWarrantModalOpen, setIsUpdateWarrantModalOpen,
        isExternalToolModalOpen, setIsExternalToolModalOpen,
        isSyncUsersModalOpen, setIsSyncUsersModalOpen,
        isManageSpecializationsModalOpen, setIsManageSpecializationsModalOpen,
        isRequestClearanceModalOpen, setIsRequestClearanceModalOpen,
        isCaseDetailsModalOpen, setIsCaseDetailsModalOpen,
        isIssueEamModalOpen, setIsIssueEamModalOpen,

        // HR Modals
        isScheduleInterviewModalOpen, setIsScheduleInterviewModalOpen,
        isConductInterviewModalOpen, setIsConductInterviewModalOpen,
        isCreateJobModalOpen, setIsCreateJobModalOpen,
        isApplyJobModalOpen, setIsApplyJobModalOpen,
        isCreateTemplateModalOpen, setIsCreateTemplateModalOpen,
        isTransferModalOpen, setIsTransferModalOpen,
        isCreatePositionModalOpen, setIsCreatePositionModalOpen,
        isAddProspectModalOpen, setIsAddProspectModalOpen,
        isAddCaseFileModalOpen, setIsAddCaseFileModalOpen,

        // Selected Data for Modals
        selectedRequest, setSelectedRequest,
        selectedOperation,
        selectedUnitDetailId,
        selectedWarrant,
        selectedBulletin, setSelectedBulletin,
        selectedUser,
        selectedHRApplicant,
        selectedHRInterview,
        selectedCaseFile,
        editingUnit, editingRank, editingNotice, editingRole, editingLocation,
        editingTeam, editingPosition, teamForPositionModal, editingExternalTool,
        editingJob, applyingJob, editingTemplate, editingInterview, editingHRPosition,

        toasts, removeToast,
        eamMessage, setEamMessage,
        operationAlert, setOperationAlert,
        volume,

        // Helper
        openModal,
        openCreateWarrantModal,
        openUpdateWarrantModal,
        viewRequestDetails,
        confirmState,
        closeConfirm,
        confirm,
        setSelectedWarrant,

        isCreateIntelWindowOpen, setIsCreateIntelWindowOpen,
        openIntelReports, closeIntelReportWindow,
        triggerIntelRefresh,
        viewDossier,
        showCreateBulletinModal, setShowCreateBulletinModal,
        minimizeWindow,
        viewingMember,
    } = useUI();

    // Initialize Supabase client with config from the API.
    useEffect(() => {
        if (config?.supabaseUrl && config?.supabaseAnonKey) {
            initializeSupabase(config.supabaseUrl, config.supabaseAnonKey);
            void notifyDbConnected();
        }
    }, [config, notifyDbConnected]);

    // Sync Metadata & Open Graph (Client Side Failsafe)
    useEffect(() => {
        const title = openGraphConfig?.title || brandingConfig?.name || 'Operations Dashboard';
        const description = openGraphConfig?.description || 'Secure Operations Terminal';
        const themeColor = openGraphConfig?.themeColor || brandingConfig?.themeColor || '#0f172a';
        const iconUrl = openGraphConfig?.faviconUrl || brandingConfig?.iconUrl || '/icon.svg';
        const ogImage = openGraphConfig?.imageUrl || iconUrl;

        const updateMeta = (name: string, content: string, attribute: 'name' | 'property' = 'name') => {
            let element = document.querySelector(`meta[${attribute}="${name}"]`);
            if (!element) {
                element = document.createElement('meta');
                element.setAttribute(attribute, name);
                document.head.appendChild(element);
            }
            element.setAttribute('content', content);
        };

        document.title = title;
        updateMeta('description', description);
        updateMeta('theme-color', themeColor);
        updateMeta('og:title', title, 'property');
        updateMeta('og:description', description, 'property');
        updateMeta('og:image', ogImage, 'property');
        updateMeta('og:site_name', brandingConfig?.name || 'Operations Dashboard', 'property');
        updateMeta('og:type', 'website', 'property');

        const updateLink = (rel: string, href: string) => {
            let el = document.querySelector(`link[rel*="${rel}"]`);
            if (!el) {
                el = document.createElement('link');
                el.setAttribute('rel', rel);
                document.head.appendChild(el);
            }
            el.setAttribute('href', href);
        };

        updateLink('icon', iconUrl);
        updateLink('apple-touch-icon', iconUrl);

    }, [brandingConfig, openGraphConfig]);

    // Sync selectedRequest with real-time data
    useEffect(() => {
        if (selectedRequest) {
            const updatedRequest = hydratedServiceRequests.find(r => r.id === selectedRequest.id);
            if (updatedRequest && updatedRequest !== selectedRequest) {
                setSelectedRequest(updatedRequest);
            }
        }
    }, [hydratedServiceRequests, selectedRequest, setSelectedRequest]);

    // --- REDIRECT ON ROLE CHANGE (e.g. demotion from Member to Client) ---
    const prevRoleRef = useRef(currentUser?.role);
    useEffect(() => {
        if (!currentUser) return;
        const prevRole = prevRoleRef.current;
        prevRoleRef.current = currentUser.role;
        if (prevRole && prevRole !== currentUser.role) {
            // Role changed — redirect to dashboard to avoid showing views the user no longer has access to
            setActiveView('dashboard');
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: keyed on currentUser?.role only; whole-object dep would re-fire on every profile field change.
    }, [currentUser?.role, setActiveView]);

    // --- PERSISTENT SIDEBAR LOGIC ---
    const compactViews = useMemo(() => ['hr', 'admin', 'wiki', 'security-vetting', 'case-file-detail', 'applicant-detail', 'internal-transfer-detail', 'internal-job-detail'], []);
    const prevViewRef = useRef(activeView);
    const sidebarPreferenceRef = useRef(isSidebarCollapsed);

    useEffect(() => {
        const wasCompact = compactViews.includes(prevViewRef.current);
        const isCompact = compactViews.includes(activeView);

        if (activeView !== prevViewRef.current) {
            if (!wasCompact && isCompact) {
                sidebarPreferenceRef.current = isSidebarCollapsed;
                setIsSidebarCollapsed(true);
            }
            else if (wasCompact && !isCompact) {
                setIsSidebarCollapsed(sidebarPreferenceRef.current);
            }
            prevViewRef.current = activeView;
        } else {
            if (!isCompact) {
                sidebarPreferenceRef.current = isSidebarCollapsed;
            }
        }
    }, [activeView, isSidebarCollapsed, compactViews, setIsSidebarCollapsed]);

    const handleToastClick = (toast: any) => {
        if (toast.requestId) {
            const req = hydratedServiceRequests.find(r => r.id === toast.requestId);
            if (req) {
                viewRequestDetails(req);
            }
        }
    };

    const renderActiveView = () => {
        switch (activeView) {
            case 'dashboard': return <DashboardView openRateRequestModal={(req: HydratedServiceRequest) => openModal(setIsRateRequestModalOpen, req)} />;
            case 'requests': return (
                <ServiceRequestsView
                    openCreateModal={() => setIsCreateModalOpen(true)}
                    openAdHocModal={() => setIsAdHocModalOpen(true)}
                    openCompleteModal={(req: HydratedServiceRequest) => openModal(setIsCompleteModalOpen, req)}
                    openRateRequestModal={(req: HydratedServiceRequest) => openModal(setIsRateRequestModalOpen, req)}
                    openAddResponderModal={(req: HydratedServiceRequest) => openModal(setIsAddResponderModalOpen, req)}
                    openUpdateStatusModal={(req: HydratedServiceRequest) => openModal(setIsUpdateRequestModalOpen, req)}
                    openTriageModal={(req: HydratedServiceRequest) => openModal(setIsTriageModalOpen, req)}
                />
            );
            case 'hr': return <HRHubView />;
            case 'wiki': return <WikiView />;
            case 'applicant-detail': return <ApplicantDetailView />;
            case 'internal-transfer-detail': return <InternalTransferView />;
            case 'internal-job-detail': return <InternalJobView />;
            case 'case-file-detail': return selectedCaseFile ? <UnifiedCaseFileView applicationId={selectedCaseFile.id} onBack={() => setActiveView('hr')} /> : <HRHubView />;
            case 'security-vetting': return selectedHRApplicant ? <SecurityVettingView applicant={selectedHRApplicant} onBack={() => setActiveView('hr')} /> : <HRHubView />;
            case 'profile': return <ProfileView />;
            case 'roster': return <DutyRosterView />;
            case 'org-chart': return <OrganisationView />;
            case 'unit-detail': return selectedUnitDetailId != null
                ? <UnitDetailView unitId={selectedUnitDetailId} onBack={() => setActiveView('org-chart')} />
                : <OrganisationView />;
            case 'admin': return <AdminPanelView />;
            case 'intel': return <IntelligenceView />;
            case 'alliances': return <AllianceDirectoryView />;
            case 'mirrored-operation-detail': return <MirroredOperationDetailViewWrapper />;
            case 'warrants': return <WarrantsView openCreateModal={openCreateWarrantModal} openUpdateModal={openUpdateWarrantModal} />;
            case 'operations': return <OperationsCenterView />;
            case 'fleet': return <FleetManagerView />;
            case 'government': return <GovernmentView />;
            case 'finances': return <FinancesView />;
            case 'quartermaster': return <QuartermasterView />;
            case 'warehouse': return <WarehouseView />;
            case 'marketplace': return <MarketplaceView />;
            case 'help': return <HelpView />;
            case 'tos': return <TermsOfServiceView onBack={() => setActiveView('help')} />;
            case 'changelog': return <ChangeLogView onBack={() => setActiveView('help')} />;
            case 'radio-control': return <RadioControlView />;
            case 'dispatch': return <DispatchCenterView />;
            case 'leaderboard': return <LeaderboardView />;
            case 'external-tools': return <ExternalToolsView />;
            case 'search': return <SearchCenterView />;
            case 'operation-detail': return <OperationDetailViewWrapper />;
            case 'request-detail': return <RequestDetailViewWrapper />;
            case 'member-record': return <MyServiceRecordView user={viewingMember || undefined} onBack={() => setActiveView('roster')} />;
            default: return <DashboardView openRateRequestModal={(req: HydratedServiceRequest) => openModal(setIsRateRequestModalOpen, req)} />;
        }
    };

    // Surface "first time loading may take a moment" helper text if the splash
    // has been up for more than 4s.
    useEffect(() => {
        const timer = setTimeout(() => setShowExtendedWait(true), 4000);
        return () => clearTimeout(timer);
    }, []);

    // One stable splash element, reused by both the boot gate and the wizard's
    // Suspense fallback. Same element type+props means BootSplash is never
    // remounted across phase changes, so the logo stays painted instead of
    // re-fading. BootSplash falls back to window.__BRANDING__ for an instant
    // branded paint.
    const splash = (
        <BootSplash
            branding={{ name: brandingConfig?.name, iconUrl: brandingConfig?.iconUrl }}
            showExtendedWait={showExtendedWait && !isInitialized}
        />
    );

    if (!isInitialized || isLoadingAuth || !bootResolved) {
        return splash;
    }

    // First-run onboarding wizard — supersedes the login/claim/RSI gates below
    // until setup is marked complete (the wizard drives those sub-steps itself).
    if (!setupCompleted) {
        return (
            <Suspense fallback={splash}>
                <OnboardingWizard />
            </Suspense>
        );
    }

    if (pendingUser) return <NewUserSetupView pendingUser={pendingUser} onSetupComplete={handleNewUserSetup} isAdminSetup={pendingUser.isAdminSetup} brandingConfig={brandingConfig} />;
    if (needsSetup) return <FirstTimeSetupView onFinalizeAdminSetup={handleFinalizeAdminSetup} />;
    // Maintenance Mode — block all non-admin members (toggled by an Admin in the
    // Admin Console → Database Tools; enforced server-side in services.ts/query.ts).
    if (platformSettings?.maintenance_mode === true && currentUser?.role !== 'Admin') {
        const maintenanceMessage = platformSettings?.maintenance_message || 'The dashboard is currently undergoing scheduled maintenance. Please check back shortly.';
        return (
            <div className="fixed inset-0 h-dvh w-screen bg-slate-950 flex flex-col items-center justify-center overflow-hidden relative z-9999">
                <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--tw-gradient-stops))] from-slate-800/20 via-slate-950 to-slate-950"></div>
                <div className="relative z-10 w-full max-w-lg p-8 flex flex-col items-center text-center">
                    <div className="relative mb-8">
                        <div className="absolute inset-0 bg-amber-500 blur-3xl opacity-20 animate-pulse rounded-full"></div>
                        <div className="relative z-10 w-20 h-20 rounded-full bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
                            <i className="fa-solid fa-wrench text-amber-400 text-3xl"></i>
                        </div>
                    </div>
                    <h1 className="text-2xl font-black text-white tracking-wider uppercase mb-2">Maintenance Mode</h1>
                    <div className="h-px w-24 bg-linear-to-r from-transparent via-amber-500 to-transparent mb-6 opacity-50"></div>
                    <p className="text-slate-300 text-sm leading-relaxed mb-8 max-w-md">{maintenanceMessage}</p>
                    <div className="flex items-center gap-2 text-xs text-slate-500 font-mono uppercase tracking-widest">
                        <div className="w-2 h-2 bg-amber-500 rounded-full animate-pulse"></div>
                        <span>System Offline</span>
                    </div>
                    {/* Admin escape hatch: lets a signed-out admin authenticate from
                        the maintenance screen. Maintenance mode is still enforced
                        server-side (services.ts/query.ts re-check role===Admin), so a
                        non-admin who signs in here just lands back on this screen. */}
                    <button
                        onClick={handleLogin}
                        className="mt-10 inline-flex items-center gap-2 text-[11px] font-mono uppercase tracking-widest text-slate-600 hover:text-amber-400 transition-colors"
                    >
                        <i className="fa-brands fa-discord"></i>
                        <span>Admin Access</span>
                    </button>
                </div>
                <div className="absolute bottom-8 text-[10px] text-slate-600 font-mono uppercase tracking-[0.3em]">
                    {brandingConfig?.name || 'Operations'} {'//'} Termlink v15.1.2-open
                </div>
            </div>
        );
    }

    if (!currentUser) {
        const loginNotices = announcements.filter(a =>
            a.audience.includes('Login Screen') &&
            (!a.expiryDate || new Date(a.expiryDate) > new Date())
        );
        // /login escape hatch: internal users can bypass the public page.
        const forcedLogin = typeof window !== 'undefined' && window.location.pathname === '/login';
        const publicEnabled = typeof window !== 'undefined' && !!(window as any).__PUBLIC_PAGE__?.enabled;
        if (publicEnabled && !forcedLogin) {
            return (
                <Suspense fallback={null}>
                    <OrgPublicPage onLoginClick={handleLogin} />
                </Suspense>
            );
        }
        return <LoginView onLoginClick={handleLogin} brandingConfig={brandingConfig} announcements={loginNotices} authError={authError} onDismissAuthError={clearAuthError} />;
    }

    if (currentUser.rsiHandlePending) return <RsiVerificationRequiredView />;

    return (
        <div className="flex h-screen bg-slate-900 font-sans overflow-hidden">
            <Sidebar
                activeView={activeView}
                setActiveView={setActiveView}
                isSidebarCollapsed={isSidebarCollapsed}
                setIsSidebarCollapsed={setIsSidebarCollapsed}
                isMobileOpen={isMobileSidebarOpen}
                setIsMobileOpen={setIsMobileSidebarOpen}
            />

            <div className="flex-1 flex flex-col min-w-0 relative">
                <Header
                    setActiveView={setActiveView}
                    toggleMobileSidebar={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
                    isMobileSidebarOpen={isMobileSidebarOpen}
                />
                <main className={`flex-1 flex flex-col relative ${fullScreenViews.includes(activeView) ? 'overflow-hidden h-full' : 'overflow-y-auto p-4 md:p-6 lg:p-8'}`}>
                    <div key={activeView} className={`view-container flex-1 ${fullScreenViews.includes(activeView) ? 'h-full' : 'min-h-full'}`}>
                        <Suspense fallback={<LoadingFallback />}>
                            <ErrorBoundary>
                                {renderActiveView()}
                            </ErrorBoundary>
                        </Suspense>
                    </div>
                </main>
            </div>

            <div className="fixed top-24 right-6 z-200 flex flex-col space-y-3 pointer-events-none">
                {toasts.map(toast => {
                    // Variant tokens: solid 500 stripe for contrast on the dark base,
                    // lighter 400 for icon/accent text.
                    const VARIANT_STRIPE: Record<string, string> = {
                        success: 'bg-emerald-500',
                        error: 'bg-red-500',
                        warning: 'bg-amber-500',
                        info: 'bg-sky-500',
                        neutral: 'bg-slate-500',
                    };
                    const VARIANT_TEXT: Record<string, string> = {
                        success: 'text-emerald-400',
                        error: 'text-red-400',
                        warning: 'text-amber-400',
                        info: 'text-sky-400',
                        neutral: 'text-slate-400',
                    };
                    const VARIANT_DEFAULT_ICON: Record<string, string> = {
                        success: 'fa-circle-check',
                        error: 'fa-circle-xmark',
                        warning: 'fa-triangle-exclamation',
                        info: 'fa-circle-info',
                        neutral: 'fa-circle-info',
                    };
                    const stripeCls = VARIANT_STRIPE[toast.variant] || VARIANT_STRIPE.info;
                    const accentCls = VARIANT_TEXT[toast.variant] || VARIANT_TEXT.info;
                    const renderedIcon = toast.icon ?? <i className={`fa-solid ${VARIANT_DEFAULT_ICON[toast.variant] || VARIANT_DEFAULT_ICON.info}`} />;

                    return (
                        <div
                            key={toast.id}
                            onClick={() => handleToastClick(toast)}
                            className={`relative bg-slate-950/80 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl flex items-start min-w-[340px] max-w-[420px] p-4 pl-5 pr-10 animate-toast-in pointer-events-auto overflow-hidden group transition-transform ${toast.requestId ? 'cursor-pointer hover:scale-[1.02]' : ''}`}
                        >
                            {/* Accent stripe — variant severity */}
                            <div className={`absolute top-0 left-0 bottom-0 w-1 ${stripeCls}`} aria-hidden />

                            {/* Progress bar — skipped for persistent toasts */}
                            {!toast.persistent && (
                                <div className="absolute bottom-0 left-0 h-0.5 w-full bg-white/5">
                                    <div
                                        className="h-full bg-white/30 origin-left"
                                        style={{ animation: `progressBar ${toast.durationMs}ms linear forwards` }}
                                    />
                                </div>
                            )}

                            <div className={`text-lg mr-3 mt-0.5 shrink-0 ${accentCls}`}>{renderedIcon}</div>
                            <div className="flex-1 min-w-0">
                                <div className="font-bold text-sm uppercase tracking-wide leading-tight text-white">{toast.message}</div>
                                {toast.description && <p className="text-xs text-slate-400 mt-1 leading-snug">{toast.description}</p>}
                                {toast.requestId && (
                                    <div className="text-xs text-sky-300 hover:text-sky-200 mt-1.5 font-semibold">
                                        View details <i className="fa-solid fa-arrow-right ml-1 text-[10px]"></i>
                                    </div>
                                )}
                            </div>
                            <button
                                onClick={(e) => { e.stopPropagation(); removeToast(toast.id); }}
                                className="absolute top-2 right-2 text-slate-500 hover:text-white transition-colors p-1.5"
                                title="Dismiss"
                            >
                                <i className="fa-solid fa-xmark text-xs"></i>
                            </button>
                        </div>
                    );
                })}
            </div>
            <PushNotificationBanner />

            {/* Global Modals */}
            {eamMessage && <EamModal message={eamMessage} onClose={() => setEamMessage(null)} soundUrl={brandingConfig.eamSoundUrl} volume={volume} />}
            {operationAlert && <OperationAlertModal message={operationAlert.message} senderName={operationAlert.senderName} operationId={operationAlert.operationId} onClose={() => setOperationAlert(null)} soundUrl={brandingConfig.assignmentSoundUrl} volume={volume} />}
            {isIssueEamModalOpen && <IssueEamModal isOpen={isIssueEamModalOpen} onClose={() => setIsIssueEamModalOpen(false)} />}
            {isCreateModalOpen && <CreateRequestModal isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} />}
            {isAdHocModalOpen && <CreateAdHocRequestModal isOpen={isAdHocModalOpen} onClose={() => setIsAdHocModalOpen(false)} />}
            {isCompleteModalOpen && selectedRequest && <CompleteRequestModal isOpen={isCompleteModalOpen} onClose={() => setIsCompleteModalOpen(false)} request={selectedRequest} />}
            {isAddResponderModalOpen && selectedRequest && <AddResponderModal isOpen={isAddResponderModalOpen} onClose={() => setIsAddResponderModalOpen(false)} request={selectedRequest} />}
            {isUpdateRequestModalOpen && selectedRequest && <UpdateRequestModal isOpen={isUpdateRequestModalOpen} onClose={() => setIsUpdateRequestModalOpen(false)} request={selectedRequest} />}
            {isRateRequestModalOpen && selectedRequest && <RateRequestModal isOpen={isRateRequestModalOpen} onClose={() => setIsRateRequestModalOpen(false)} request={selectedRequest} />}
            {isTriageModalOpen && selectedRequest && <TriageRequestModal isOpen={isTriageModalOpen} onClose={() => setIsTriageModalOpen(false)} request={selectedRequest} />}
            {isDispatchModalOpen && selectedRequest && <DispatchModal isOpen={isDispatchModalOpen} onClose={() => setIsDispatchModalOpen(false)} request={selectedRequest} />}
            {isAdjustReputationModalOpen && selectedUser && <AdjustReputationModal isOpen={isAdjustReputationModalOpen} onClose={() => setIsAdjustReputationModalOpen(false)} user={selectedUser} />}
            {isBulkAssignClearanceModalOpen && <BulkAssignClearanceModal isOpen={isBulkAssignClearanceModalOpen} onClose={() => setIsBulkAssignClearanceModalOpen(false)} />}
            {isReputationHistoryModalOpen && selectedUser && <ReputationHistoryModal isOpen={isReputationHistoryModalOpen} onClose={() => setIsReputationHistoryModalOpen(false)} user={selectedUser} />}
            {isRatingHistoryModalOpen && selectedUser && <RatingHistoryModal isOpen={isRatingHistoryModalOpen} onClose={() => setIsRatingHistoryModalOpen(false)} user={selectedUser} />}
            {isDeleteAccountModalOpen && <DeleteAccountModal isOpen={isDeleteAccountModalOpen} onClose={() => setIsDeleteAccountModalOpen(false)} />}
            {isAddConductEntryModalOpen && selectedUser && <AddConductEntryModal isOpen={isAddConductEntryModalOpen} onClose={() => setIsAddConductEntryModalOpen(false)} user={selectedUser} />}
            {isAwardSingleCertModalOpen && selectedUser && <AwardSingleCertificationModal isOpen={isAwardSingleCertModalOpen} onClose={() => setIsAwardSingleCertModalOpen(false)} user={selectedUser} />}
            {isAwardSingleCommendModalOpen && selectedUser && <AwardSingleCommendationModal isOpen={isAwardSingleCommendModalOpen} onClose={() => setIsAwardSingleCommendModalOpen(false)} user={selectedUser} />}
            {isUnitModalOpen && <UnitModal isOpen={isUnitModalOpen} onClose={() => setIsUnitModalOpen(false)} unit={editingUnit} />}
            {isRankModalOpen && <RankModal isOpen={isRankModalOpen} onClose={() => setIsRankModalOpen(false)} rank={editingRank} />}
            {isNoticeModalOpen && <NoticeModal isOpen={isNoticeModalOpen} onClose={() => setIsNoticeModalOpen(false)} notice={editingNotice} />}
            {isRoleModalOpen && <RoleModal isOpen={isRoleModalOpen} onClose={() => setIsRoleModalOpen(false)} role={editingRole} />}
            {isLocationModalOpen && <LocationModal isOpen={isLocationModalOpen} onClose={() => setIsLocationModalOpen(false)} location={editingLocation} />}
            {isCreateOperationModalOpen && <CreateOperationWizard isOpen={isCreateOperationModalOpen} onClose={() => setIsCreateOperationModalOpen(false)} />}
            {isOperationTemplatesModalOpen && <OperationTemplatesModal isOpen={isOperationTemplatesModalOpen} onClose={() => setIsOperationTemplatesModalOpen(false)} />}
            {isTeamModalOpen && selectedOperation && <TeamModal isOpen={isTeamModalOpen} onClose={() => setIsTeamModalOpen(false)} operation={selectedOperation} team={editingTeam} />}
            {isPositionModalOpen && teamForPositionModal && <PositionModal isOpen={isPositionModalOpen} onClose={() => setIsPositionModalOpen(false)} team={teamForPositionModal} position={editingPosition} />}
            {isCreateWarrantModalOpen && <CreateWarrantModal isOpen={isCreateWarrantModalOpen} onClose={() => setIsCreateWarrantModalOpen(false)} />}
            {isUpdateWarrantModalOpen && selectedWarrant && <UpdateWarrantModal isOpen={isUpdateWarrantModalOpen} onClose={() => { setIsUpdateWarrantModalOpen(false); setSelectedWarrant(null); }} warrant={selectedWarrant} />}
            {!isUpdateWarrantModalOpen && selectedWarrant && <WarrantDetailModal isOpen={true} onClose={() => setSelectedWarrant(null)} warrant={selectedWarrant} onEdit={() => { setIsUpdateWarrantModalOpen(true); }} />}
            {selectedBulletin && <BulletinDetailModal isOpen={true} onClose={() => setSelectedBulletin(null)} bulletin={selectedBulletin} onDelete={async (id) => { await deleteBulletin(id); setSelectedBulletin(null); }} />}
            {isExternalToolModalOpen && <ExternalToolModal isOpen={isExternalToolModalOpen} onClose={() => setIsExternalToolModalOpen(false)} tool={editingExternalTool} />}
            {isSyncUsersModalOpen && <SyncUsersModal isOpen={isSyncUsersModalOpen} onClose={() => setIsSyncUsersModalOpen(false)} />}
            {isCreateJobModalOpen && <CreateJobModal isOpen={isCreateJobModalOpen} onClose={() => setIsCreateJobModalOpen(false)} job={editingJob} />}
            {isApplyJobModalOpen && applyingJob && <ApplyJobModal isOpen={isApplyJobModalOpen} onClose={() => setIsApplyJobModalOpen(false)} job={applyingJob} />}
            {isCreateTemplateModalOpen && <CreateTemplateModal isOpen={isCreateTemplateModalOpen} onClose={() => setIsCreateTemplateModalOpen(false)} template={editingTemplate} />}
            {isTransferModalOpen && <CreateTransferModal isOpen={isTransferModalOpen} onClose={() => setIsTransferModalOpen(false)} />}
            {isCreatePositionModalOpen && <CreatePositionModal isOpen={isCreatePositionModalOpen} onClose={() => setIsCreatePositionModalOpen(false)} position={editingHRPosition} />}
            {isAddProspectModalOpen && <AddProspectModal isOpen={isAddProspectModalOpen} onClose={() => setIsAddProspectModalOpen(false)} />}
            {isAddCaseFileModalOpen && <AddCaseFileModal isOpen={isAddCaseFileModalOpen} onClose={() => setIsAddCaseFileModalOpen(false)} />}
            {isScheduleInterviewModalOpen && <ScheduleInterviewModal isOpen={isScheduleInterviewModalOpen} onClose={() => setIsScheduleInterviewModalOpen(false)} applicant={selectedHRApplicant} editingInterview={editingInterview} />}
            {isConductInterviewModalOpen && selectedHRInterview && <ConductInterviewModal isOpen={isConductInterviewModalOpen} onClose={() => setIsConductInterviewModalOpen(false)} interview={selectedHRInterview} />}
            {isManageSpecializationsModalOpen && <ManageSpecializationsModal isOpen={isManageSpecializationsModalOpen} onClose={() => setIsManageSpecializationsModalOpen(false)} />}
            {isCaseDetailsModalOpen && selectedCaseFile && <CaseDetailsModal isOpen={isCaseDetailsModalOpen} onClose={() => setIsCaseDetailsModalOpen(false)} caseFile={selectedCaseFile} />}
            {isRequestClearanceModalOpen && <RequestClearanceModal isOpen={isRequestClearanceModalOpen} onClose={() => setIsRequestClearanceModalOpen(false)} />}

            {/* Global Confirm Dialog */}
            <ConfirmDialog
                isOpen={confirmState.isOpen}
                options={confirmState.options}
                onConfirm={() => { if (confirmState.resolve) confirmState.resolve(true); closeConfirm(); }}
                onCancel={() => { if (confirmState.resolve) confirmState.resolve(false); closeConfirm(); }}
            />

            {/* Persistent Intel Windows */}
            {isCreateIntelWindowOpen && (
                <CreateIntelReportModal
                    isOpen={isCreateIntelWindowOpen}
                    onClose={() => setIsCreateIntelWindowOpen(false)}
                    onSuccess={triggerIntelRefresh}
                    onMinimize={() => {
                        setIsCreateIntelWindowOpen(false);
                        minimizeWindow({ id: 'intel-create', title: 'New Intel Report', icon: 'fa-solid fa-file-shield', color: 'sky', type: 'intel-create' });
                    }}
                />
            )}

            {/* Multi-window Intel Report Detail */}
            {openIntelReports.map((report, index) => (
                <IntelReportDetailModal
                    key={report.id}
                    isOpen={true}
                    onClose={() => closeIntelReportWindow(report.id)}
                    report={report}
                    onViewDossier={viewDossier}
                    onDelete={async () => {
                        const confirmed = await confirm({
                            title: 'Purge Intelligence Record',
                            message: 'Are you sure you want to permanently delete this intelligence record? This action cannot be reversed and will be logged.',
                            variant: 'danger',
                            confirmText: 'Purge Record'
                        });
                        if (!confirmed) return;
                        deleteIntelReport(report.id).then(() => { triggerIntelRefresh(); closeIntelReportWindow(report.id); });
                    }}
                    onUpdate={triggerIntelRefresh}
                    onMinimize={() => {
                        closeIntelReportWindow(report.id);
                        minimizeWindow({
                            id: `intel-report-${report.id}`,
                            title: report.targetId,
                            icon: 'fa-solid fa-file-contract',
                            color: report.threatLevel === 'Critical' ? 'red' : report.threatLevel === 'High' ? 'amber' : 'slate',
                            type: 'intel-report',
                            restoreData: report
                        });
                    }}
                    initialOffset={index * 30}
                />
            ))}

            {showCreateBulletinModal && (
                <CreateBulletinModal
                    isOpen={showCreateBulletinModal}
                    onClose={() => setShowCreateBulletinModal(false)}
                />
            )}

            <RadioOverlay />
            <RadioWidget />
            <WindowTaskbar />
            <NotificationListener />
        </div>
    );
}

const fullScreenViews = ['admin', 'applicant-detail', 'security-vetting', 'case-file-detail', 'search', 'internal-transfer-detail', 'internal-job-detail', 'intel', 'member-record', 'operation-detail', 'mirrored-operation-detail', 'operations', 'request-detail', 'dispatch', 'wiki', 'government', 'finances', 'quartermaster', 'warehouse', 'marketplace', 'alliances', 'requests', 'warrants', 'roster', 'leaderboard', 'external-tools', 'radio-control', 'profile', 'help', 'tos', 'changelog', 'hr', 'fleet', 'org-chart', 'unit-detail'];

const OperationDetailViewWrapper = () => {
    const { selectedOperation, setActiveView } = useUI();
    useEffect(() => { if (!selectedOperation) setActiveView('operations'); }, [selectedOperation, setActiveView]);
    return selectedOperation ? <OperationDetailView operation={selectedOperation} onBack={() => setActiveView('operations')} /> : null;
}

const MirroredOperationDetailViewWrapper = () => {
    const { selectedMirroredOperation, setActiveView } = useUI();
    useEffect(() => { if (!selectedMirroredOperation) setActiveView('operations'); }, [selectedMirroredOperation, setActiveView]);
    return selectedMirroredOperation ? <MirroredOperationDetailView mirror={selectedMirroredOperation} onBack={() => setActiveView('operations')} /> : null;
}

const RequestDetailViewWrapper = () => {
    const { selectedRequest, setActiveView, openModal, setIsCompleteModalOpen, setIsRateRequestModalOpen, setIsAddResponderModalOpen, setIsUpdateRequestModalOpen, setIsTriageModalOpen, setIsDispatchModalOpen } = useUI();
    useEffect(() => { if (!selectedRequest) setActiveView('requests'); }, [selectedRequest, setActiveView]);
    if (!selectedRequest) return null;
    return (
        <ServiceRequestDetailView
            request={selectedRequest}
            onBack={() => setActiveView('requests')}
            openCompleteModal={(req: HydratedServiceRequest) => openModal(setIsCompleteModalOpen, req)}
            openRateRequestModal={(req: HydratedServiceRequest) => openModal(setIsRateRequestModalOpen, req)}
            openAddResponderModal={(req: HydratedServiceRequest) => openModal(setIsAddResponderModalOpen, req)}
            openUpdateStatusModal={(req: HydratedServiceRequest) => openModal(setIsUpdateRequestModalOpen, req)}
            openTriageModal={(req: HydratedServiceRequest) => openModal(setIsTriageModalOpen, req)}
            openDispatchModal={(req: HydratedServiceRequest) => openModal(setIsDispatchModalOpen, req)}
        />
    );
}

const DashboardApp: React.FC = () => (
    <UIProvider>
        <DataCoreProvider>
            <MembersProvider>
                <ConfigProvider>
                    <OperationsProvider>
                        <IntelProvider>
                            <HRProvider>
                                <WarehouseProvider>
                                    <FleetProvider>
                                        <GovernmentProvider>
                                            <RequestsProvider>
                                                <AnnouncementsProvider>
                                                    <DataProvider>
                                                        <AuthProvider>
                                                            <HIDPTTProvider>
                                                                <RadioProvider>
                                                                    <AppContent />
                                                                </RadioProvider>
                                                            </HIDPTTProvider>
                                                        </AuthProvider>
                                                    </DataProvider>
                                                </AnnouncementsProvider>
                                            </RequestsProvider>
                                        </GovernmentProvider>
                                    </FleetProvider>
                                </WarehouseProvider>
                            </HRProvider>
                        </IntelProvider>
                    </OperationsProvider>
                </ConfigProvider>
            </MembersProvider>
        </DataCoreProvider>
    </UIProvider>
);

export default DashboardApp;
