import React, { createContext, useState, useCallback, use } from 'react';
import {
    User,
    OrganizationalUnit,
    Rank,
    Announcement,
    HydratedWarrant,
    ExternalTool,
    Role,
    Location,
    JobPosting,
    HRInterviewTemplate,
    PersonnelPosition,
    HydratedHRApplication,
    HydratedHRInterview,
    ServiceTypeConfig,
    HydratedIntelligenceReport,
    MinimizedWindow,
} from '../types';
import { useNavigation } from './NavigationContext';

export interface ModalRegistryContextType {
    // Modals
    isCreateModalOpen: boolean; setIsCreateModalOpen: (isOpen: boolean) => void;
    isAdHocModalOpen: boolean; setIsAdHocModalOpen: (isOpen: boolean) => void;
    isCompleteModalOpen: boolean; setIsCompleteModalOpen: (isOpen: boolean) => void;
    isAddResponderModalOpen: boolean; setIsAddResponderModalOpen: (isOpen: boolean) => void;
    isRateRequestModalOpen: boolean; setIsRateRequestModalOpen: (isOpen: boolean) => void;
    isUpdateRequestModalOpen: boolean; setIsUpdateRequestModalOpen: (isOpen: boolean) => void;
    isAdjustReputationModalOpen: boolean; setIsAdjustReputationModalOpen: (isOpen: boolean) => void;
    isBulkAssignClearanceModalOpen: boolean; setIsBulkAssignClearanceModalOpen: (isOpen: boolean) => void;
    isUnitModalOpen: boolean; setIsUnitModalOpen: (isOpen: boolean) => void;
    isRankModalOpen: boolean; setIsRankModalOpen: (isOpen: boolean) => void;
    isNoticeModalOpen: boolean; setIsNoticeModalOpen: (isOpen: boolean) => void;
    isRoleModalOpen: boolean; setIsRoleModalOpen: (isOpen: boolean) => void;
    isLocationModalOpen: boolean; setIsLocationModalOpen: (isOpen: boolean) => void;
    isTriageModalOpen: boolean; setIsTriageModalOpen: (isOpen: boolean) => void;
    isDispatchModalOpen: boolean; setIsDispatchModalOpen: (isOpen: boolean) => void;
    isReputationHistoryModalOpen: boolean; setIsReputationHistoryModalOpen: (isOpen: boolean) => void;
    isRatingHistoryModalOpen: boolean; setIsRatingHistoryModalOpen: (isOpen: boolean) => void;
    isDeleteAccountModalOpen: boolean; setIsDeleteAccountModalOpen: (isOpen: boolean) => void;
    isAwardSingleCertModalOpen: boolean; setIsAwardSingleCertModalOpen: (isOpen: boolean) => void;
    isAwardSingleCommendModalOpen: boolean; setIsAwardSingleCommendModalOpen: (isOpen: boolean) => void;
    isAddConductEntryModalOpen: boolean; setIsAddConductEntryModalOpen: (isOpen: boolean) => void;
    isCreateOperationModalOpen: boolean; setIsCreateOperationModalOpen: (isOpen: boolean) => void;
    isOperationTemplatesModalOpen: boolean; setIsOperationTemplatesModalOpen: (isOpen: boolean) => void;
    isTeamModalOpen: boolean; setIsTeamModalOpen: (isOpen: boolean) => void;
    isPositionModalOpen: boolean; setIsPositionModalOpen: (isOpen: boolean) => void;
    isCreateWarrantModalOpen: boolean; setIsCreateWarrantModalOpen: (isOpen: boolean) => void;
    isUpdateWarrantModalOpen: boolean; setIsUpdateWarrantModalOpen: (isOpen: boolean) => void;
    isExternalToolModalOpen: boolean; setIsExternalToolModalOpen: (isOpen: boolean) => void;
    isSyncUsersModalOpen: boolean; setIsSyncUsersModalOpen: (isOpen: boolean) => void;
    isManageSpecializationsModalOpen: boolean; setIsManageSpecializationsModalOpen: (isOpen: boolean) => void;
    isRequestClearanceModalOpen: boolean; setIsRequestClearanceModalOpen: (isOpen: boolean) => void;
    isIssueEamModalOpen: boolean; setIsIssueEamModalOpen: (isOpen: boolean) => void;
    isServiceTypeModalOpen: boolean; setIsServiceTypeModalOpen: (isOpen: boolean) => void;

    // HR Modals
    isScheduleInterviewModalOpen: boolean; setIsScheduleInterviewModalOpen: (isOpen: boolean) => void;
    isConductInterviewModalOpen: boolean; setIsConductInterviewModalOpen: (isOpen: boolean) => void;
    isCreateJobModalOpen: boolean; setIsCreateJobModalOpen: (isOpen: boolean) => void;
    isApplyJobModalOpen: boolean; setIsApplyJobModalOpen: (isOpen: boolean) => void;
    isCreateTemplateModalOpen: boolean; setIsCreateTemplateModalOpen: (isOpen: boolean) => void;
    isTransferModalOpen: boolean; setIsTransferModalOpen: (isOpen: boolean) => void;
    isCreatePositionModalOpen: boolean; setIsCreatePositionModalOpen: (isOpen: boolean) => void;
    isAddProspectModalOpen: boolean; setIsAddProspectModalOpen: (isOpen: boolean) => void;
    isAddCaseFileModalOpen: boolean; setIsAddCaseFileModalOpen: (isOpen: boolean) => void;
    isCaseDetailsModalOpen: boolean; setIsCaseDetailsModalOpen: (isOpen: boolean) => void;

    // Generic + specific openers
    openModal: (setIsOpen: (isOpen: boolean) => void, data?: any) => void;
    openCreateWarrantModal: () => void;
    openUpdateWarrantModal: (warrant: HydratedWarrant) => void;

    openUnitModal: (unit?: OrganizationalUnit) => void;
    openRankModal: (rank?: Rank) => void;
    openNoticeModal: (notice?: Announcement) => void;
    openRoleModal: (role?: Role) => void;
    openLocationModal: (location?: Location) => void;
    openExternalToolModal: (tool?: ExternalTool) => void;
    openServiceTypeModal: (config?: ServiceTypeConfig) => void;

    openAdjustReputationModal: (user: User) => void;
    openBulkAssignClearanceModal: () => void;
    openReputationHistoryModal: (user: User) => void;
    openRatingHistoryModal: (user: User) => void;
    openAwardSingleCertModal: (user: User) => void;
    openAwardSingleCommendModal: (user: User) => void;
    openAddConductEntryModal: (user: User) => void;
    openDeleteAccountModal: () => void;

    openCreateJobModal: (job?: JobPosting) => void;
    openApplyJobModal: (job: JobPosting) => void;
    openCreateTemplateModal: (template?: HRInterviewTemplate) => void;
    openTransferModal: () => void;
    openCreateOperationModal: () => void;
    openOperationTemplatesModal: () => void;

    openScheduleInterviewModal: (applicant?: HydratedHRApplication | null) => void;
    openEditInterviewModal: (interview: HydratedHRInterview) => void;
    openConductInterviewModal: (interview: HydratedHRInterview) => void;
    openAddProspectModal: () => void;
    openAddCaseFileModal: () => void;
    openSecurityVettingModal: (applicant: HydratedHRApplication) => void;
    openGenericCaseFileModal: (applicant: HydratedHRApplication) => void;
    openCaseDetailsModal: (caseFile: HydratedHRApplication) => void;
    openRequestClearanceModal: () => void;
    openCreatePositionModal: (position?: PersonnelPosition) => void;
    openIssueEamModal: () => void;

    openWindow: (type: 'request' | 'warrant', data: any) => void;

    // Intel Windows (supports multiple open reports)
    isCreateIntelWindowOpen: boolean; setIsCreateIntelWindowOpen: (isOpen: boolean) => void;
    openIntelReports: HydratedIntelligenceReport[];
    openCreateIntelWindow: () => void;
    openIntelReportWindow: (report: HydratedIntelligenceReport) => void;
    closeIntelReportWindow: (reportId: string) => void;
    intelRefreshTrigger: number;
    triggerIntelRefresh: () => void;

    // Backward compat — alias for opening single report windows
    selectedIntelReport: HydratedIntelligenceReport | null;
    setSelectedIntelReport: (report: HydratedIntelligenceReport | null) => void;

    // Bulletin Modal
    showCreateBulletinModal: boolean; setShowCreateBulletinModal: (isOpen: boolean) => void;

    // Window Minimization
    minimizedWindows: MinimizedWindow[];
    minimizeWindow: (window: MinimizedWindow) => void;
    restoreWindow: (windowId: string) => void;
    closeMinimizedWindow: (windowId: string) => void;
}

const ModalRegistryContext = createContext<ModalRegistryContextType | null>(null);

export const ModalRegistryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const {
        setSelectedRequest,
        setSelectedWarrant,
        setEditingUnit,
        setEditingRank,
        setEditingNotice,
        setEditingRole,
        setEditingLocation,
        setEditingExternalTool,
        setEditingServiceType,
        setSelectedUser,
        setEditingJob,
        setApplyingJob,
        setEditingTemplate,
        setEditingInterview,
        setSelectedHRApplicant,
        setSelectedHRInterview,
        setSelectedCaseFile,
        setEditingHRPosition,
        setActiveView,
        viewRequestDetails,
    } = useNavigation();

    // Modals
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
    const [isAdHocModalOpen, setIsAdHocModalOpen] = useState(false);
    const [isCompleteModalOpen, setIsCompleteModalOpen] = useState(false);
    const [isAddResponderModalOpen, setIsAddResponderModalOpen] = useState(false);
    const [isRateRequestModalOpen, setIsRateRequestModalOpen] = useState(false);
    const [isUpdateRequestModalOpen, setIsUpdateRequestModalOpen] = useState(false);
    const [isAdjustReputationModalOpen, setIsAdjustReputationModalOpen] = useState(false);
    const [isBulkAssignClearanceModalOpen, setIsBulkAssignClearanceModalOpen] = useState(false);
    const [isUnitModalOpen, setIsUnitModalOpen] = useState(false);
    const [isRankModalOpen, setIsRankModalOpen] = useState(false);
    const [isNoticeModalOpen, setIsNoticeModalOpen] = useState(false);
    const [isRoleModalOpen, setIsRoleModalOpen] = useState(false);
    const [isLocationModalOpen, setIsLocationModalOpen] = useState(false);
    const [isTriageModalOpen, setIsTriageModalOpen] = useState(false);
    const [isDispatchModalOpen, setIsDispatchModalOpen] = useState(false);
    const [isReputationHistoryModalOpen, setIsReputationHistoryModalOpen] = useState(false);
    const [isRatingHistoryModalOpen, setIsRatingHistoryModalOpen] = useState(false);
    const [isDeleteAccountModalOpen, setIsDeleteAccountModalOpen] = useState(false);
    const [isAwardSingleCertModalOpen, setIsAwardSingleCertModalOpen] = useState(false);
    const [isAwardSingleCommendModalOpen, setIsAwardSingleCommendModalOpen] = useState(false);
    const [isAddConductEntryModalOpen, setIsAddConductEntryModalOpen] = useState(false);
    const [isCreateOperationModalOpen, setIsCreateOperationModalOpen] = useState(false);
    const [isOperationTemplatesModalOpen, setIsOperationTemplatesModalOpen] = useState(false);
    const [isTeamModalOpen, setIsTeamModalOpen] = useState(false);
    const [isPositionModalOpen, setIsPositionModalOpen] = useState(false);
    const [isCreateWarrantModalOpen, setIsCreateWarrantModalOpen] = useState(false);
    const [isUpdateWarrantModalOpen, setIsUpdateWarrantModalOpen] = useState(false);
    const [isExternalToolModalOpen, setIsExternalToolModalOpen] = useState(false);
    const [isSyncUsersModalOpen, setIsSyncUsersModalOpen] = useState(false);
    const [isManageSpecializationsModalOpen, setIsManageSpecializationsModalOpen] = useState(false);
    const [isRequestClearanceModalOpen, setIsRequestClearanceModalOpen] = useState(false);
    const [isIssueEamModalOpen, setIsIssueEamModalOpen] = useState(false);
    const [isServiceTypeModalOpen, setIsServiceTypeModalOpen] = useState(false);

    // HR Modals
    const [isScheduleInterviewModalOpen, setIsScheduleInterviewModalOpen] = useState(false);
    const [isConductInterviewModalOpen, setIsConductInterviewModalOpen] = useState(false);
    const [isCreateJobModalOpen, setIsCreateJobModalOpen] = useState(false);
    const [isApplyJobModalOpen, setIsApplyJobModalOpen] = useState(false);
    const [isCreateTemplateModalOpen, setIsCreateTemplateModalOpen] = useState(false);
    const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
    const [isCreatePositionModalOpen, setIsCreatePositionModalOpen] = useState(false);
    const [isAddProspectModalOpen, setIsAddProspectModalOpen] = useState(false);
    const [isAddCaseFileModalOpen, setIsAddCaseFileModalOpen] = useState(false);
    const [isCaseDetailsModalOpen, setIsCaseDetailsModalOpen] = useState(false);

    // Intel State (multi-window)
    const [isCreateIntelWindowOpen, setIsCreateIntelWindowOpen] = useState(false);
    const [openIntelReports, setOpenIntelReports] = useState<HydratedIntelligenceReport[]>([]);
    const [intelRefreshTrigger, setIntelRefreshTrigger] = useState(0);
    const [showCreateBulletinModal, setShowCreateBulletinModal] = useState(false);

    // Window Minimization
    const [minimizedWindows, setMinimizedWindows] = useState<MinimizedWindow[]>([]);

    // --- HELPER FUNCTIONS ---

    const openModal = useCallback((setIsOpen: (isOpen: boolean) => void, data?: any) => {
        if (data) {
            if (setIsOpen === setIsRateRequestModalOpen || setIsOpen === setIsCompleteModalOpen || setIsOpen === setIsAddResponderModalOpen || setIsOpen === setIsUpdateRequestModalOpen || setIsOpen === setIsTriageModalOpen || setIsOpen === setIsDispatchModalOpen) {
                setSelectedRequest(data);
            }
        }
        setIsOpen(true);
    }, [setSelectedRequest]);

    const openWindow = useCallback((type: 'request' | 'warrant', data: any) => {
        if (type === 'request') viewRequestDetails(data);
    }, [viewRequestDetails]);

    const triggerIntelRefresh = useCallback(() => setIntelRefreshTrigger(prev => prev + 1), []);
    const openCreateIntelWindow = useCallback(() => setIsCreateIntelWindowOpen(true), []);
    const openIntelReportWindow = useCallback((report: HydratedIntelligenceReport) => {
        setOpenIntelReports(prev => {
            // Don't add duplicate — bring to front if already open
            if (prev.some(r => r.id === report.id)) return prev;
            return [...prev, report];
        });
        // Also remove from minimized if it was minimized
        setMinimizedWindows(prev => prev.filter(w => w.id !== `intel-report-${report.id}`));
    }, []);
    const closeIntelReportWindow = useCallback((reportId: string) => {
        setOpenIntelReports(prev => prev.filter(r => r.id !== reportId));
    }, []);

    // Backward compat — selectedIntelReport returns first open report or null
    const selectedIntelReport = openIntelReports.length > 0 ? openIntelReports[0] : null;
    const setSelectedIntelReport = useCallback((report: HydratedIntelligenceReport | null) => {
        if (report) {
            openIntelReportWindow(report);
        } else {
            // Close all open reports (legacy behavior)
            setOpenIntelReports([]);
        }
    }, [openIntelReportWindow]);

    // Window Minimization
    const minimizeWindow = useCallback((window: MinimizedWindow) => {
        setMinimizedWindows(prev => {
            if (prev.some(w => w.id === window.id)) return prev;
            return [...prev, window];
        });
    }, []);
    const restoreWindow = useCallback((windowId: string) => {
        setMinimizedWindows(prev => {
            const win = prev.find(w => w.id === windowId);
            if (!win) return prev;

            // Restore based on window type
            if (win.type === 'intel-report' && win.restoreData) {
                setOpenIntelReports(p => {
                    if (p.some(r => r.id === win.restoreData.id)) return p;
                    return [...p, win.restoreData];
                });
            } else if (win.type === 'intel-create') {
                setIsCreateIntelWindowOpen(true);
            } else if (win.type === 'bulletin-create') {
                setShowCreateBulletinModal(true);
            }

            return prev.filter(w => w.id !== windowId);
        });
    }, []);
    const closeMinimizedWindow = useCallback((windowId: string) => {
        setMinimizedWindows(prev => prev.filter(w => w.id !== windowId));
    }, []);

    // Specific Openers
    const openCreateWarrantModal = useCallback(() => setIsCreateWarrantModalOpen(true), []);
    const openUpdateWarrantModal = useCallback((warrant: HydratedWarrant) => {
        setSelectedWarrant(warrant);
        setIsUpdateWarrantModalOpen(true);
    }, [setSelectedWarrant]);

    const openUnitModal = useCallback((unit?: OrganizationalUnit) => {
        setEditingUnit(unit);
        setIsUnitModalOpen(true);
    }, [setEditingUnit]);

    const openRankModal = useCallback((rank?: Rank) => {
        setEditingRank(rank);
        setIsRankModalOpen(true);
    }, [setEditingRank]);

    const openNoticeModal = useCallback((notice?: Announcement) => {
        setEditingNotice(notice);
        setIsNoticeModalOpen(true);
    }, [setEditingNotice]);

    const openRoleModal = useCallback((role?: Role) => {
        setEditingRole(role);
        setIsRoleModalOpen(true);
    }, [setEditingRole]);

    const openLocationModal = useCallback((location?: Location) => {
        setEditingLocation(location);
        setIsLocationModalOpen(true);
    }, [setEditingLocation]);

    const openExternalToolModal = useCallback((tool?: ExternalTool) => {
        setEditingExternalTool(tool);
        setIsExternalToolModalOpen(true);
    }, [setEditingExternalTool]);

    const openServiceTypeModal = useCallback((config?: ServiceTypeConfig) => {
        setEditingServiceType(config);
        setIsServiceTypeModalOpen(true);
    }, [setEditingServiceType]);

    // User Admin Helpers
    const openAdjustReputationModal = useCallback((user: User) => { setSelectedUser(user); setIsAdjustReputationModalOpen(true); }, [setSelectedUser]);
    const openBulkAssignClearanceModal = useCallback(() => setIsBulkAssignClearanceModalOpen(true), []);
    const openReputationHistoryModal = useCallback((user: User) => { setSelectedUser(user); setIsReputationHistoryModalOpen(true); }, [setSelectedUser]);
    const openRatingHistoryModal = useCallback((user: User) => { setSelectedUser(user); setIsRatingHistoryModalOpen(true); }, [setSelectedUser]);
    const openAwardSingleCertModal = useCallback((user: User) => { setSelectedUser(user); setIsAwardSingleCertModalOpen(true); }, [setSelectedUser]);
    const openAwardSingleCommendModal = useCallback((user: User) => { setSelectedUser(user); setIsAwardSingleCommendModalOpen(true); }, [setSelectedUser]);
    const openAddConductEntryModal = useCallback((user: User) => { setSelectedUser(user); setIsAddConductEntryModalOpen(true); }, [setSelectedUser]);
    const openDeleteAccountModal = useCallback(() => setIsDeleteAccountModalOpen(true), []);

    // HR Helpers
    const openCreateJobModal = useCallback((job?: JobPosting) => { setEditingJob(job); setIsCreateJobModalOpen(true); }, [setEditingJob]);
    const openApplyJobModal = useCallback((job: JobPosting) => { setApplyingJob(job); setIsApplyJobModalOpen(true); }, [setApplyingJob]);
    const openCreateTemplateModal = useCallback((template?: HRInterviewTemplate) => { setEditingTemplate(template); setIsCreateTemplateModalOpen(true); }, [setEditingTemplate]);
    const openTransferModal = useCallback(() => setIsTransferModalOpen(true), []);

    const openScheduleInterviewModal = useCallback((applicant?: HydratedHRApplication | null) => { setEditingInterview(undefined); setSelectedHRApplicant(applicant || null); setIsScheduleInterviewModalOpen(true); }, [setEditingInterview, setSelectedHRApplicant]);
    const openEditInterviewModal = useCallback((interview: HydratedHRInterview) => { setEditingInterview(interview); setSelectedHRApplicant(null); setIsScheduleInterviewModalOpen(true); }, [setEditingInterview, setSelectedHRApplicant]);
    const openConductInterviewModal = useCallback((interview: HydratedHRInterview) => { setSelectedHRInterview(interview); setIsConductInterviewModalOpen(true); }, [setSelectedHRInterview]);
    const openAddProspectModal = useCallback(() => setIsAddProspectModalOpen(true), []);
    const openAddCaseFileModal = useCallback(() => setIsAddCaseFileModalOpen(true), []);

    const openSecurityVettingModal = useCallback((applicant: HydratedHRApplication) => {
        setSelectedHRApplicant(applicant);
        setActiveView('security-vetting');
    }, [setSelectedHRApplicant, setActiveView]);

    const openGenericCaseFileModal = useCallback((applicant: HydratedHRApplication) => {
        setSelectedCaseFile(applicant);
        setActiveView('case-file-detail');
    }, [setSelectedCaseFile, setActiveView]);

    const openCaseDetailsModal = useCallback((caseFile: HydratedHRApplication) => {
        setSelectedCaseFile(caseFile);
        setIsCaseDetailsModalOpen(true);
    }, [setSelectedCaseFile]);

    const openRequestClearanceModal = useCallback(() => setIsRequestClearanceModalOpen(true), []);
    const openCreateOperationModal = useCallback(() => setIsCreateOperationModalOpen(true), []);
    const openOperationTemplatesModal = useCallback(() => setIsOperationTemplatesModalOpen(true), []);

    const openCreatePositionModal = useCallback((position?: PersonnelPosition) => { setEditingHRPosition(position); setIsCreatePositionModalOpen(true); }, [setEditingHRPosition]);

    const openIssueEamModal = useCallback(() => setIsIssueEamModalOpen(true), []);

    const value: ModalRegistryContextType = {
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
        isAwardSingleCertModalOpen, setIsAwardSingleCertModalOpen,
        isAwardSingleCommendModalOpen, setIsAwardSingleCommendModalOpen,
        isAddConductEntryModalOpen, setIsAddConductEntryModalOpen,
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
        isIssueEamModalOpen, setIsIssueEamModalOpen,
        isServiceTypeModalOpen, setIsServiceTypeModalOpen,

        isScheduleInterviewModalOpen, setIsScheduleInterviewModalOpen,
        isConductInterviewModalOpen, setIsConductInterviewModalOpen,
        isCreateJobModalOpen, setIsCreateJobModalOpen,
        isApplyJobModalOpen, setIsApplyJobModalOpen,
        isCreateTemplateModalOpen, setIsCreateTemplateModalOpen,
        isTransferModalOpen, setIsTransferModalOpen,
        isCreatePositionModalOpen, setIsCreatePositionModalOpen,
        isAddProspectModalOpen, setIsAddProspectModalOpen,
        isAddCaseFileModalOpen, setIsAddCaseFileModalOpen,
        isCaseDetailsModalOpen, setIsCaseDetailsModalOpen,

        openModal,
        openCreateWarrantModal,
        openUpdateWarrantModal,
        openUnitModal,
        openRankModal,
        openNoticeModal,
        openRoleModal,
        openLocationModal,
        openExternalToolModal,
        openServiceTypeModal,

        openAdjustReputationModal,
        openBulkAssignClearanceModal,
        openReputationHistoryModal,
        openRatingHistoryModal,
        openAwardSingleCertModal,
        openAwardSingleCommendModal,
        openAddConductEntryModal,
        openDeleteAccountModal,

        openCreateJobModal,
        openApplyJobModal,
        openCreateTemplateModal,
        openTransferModal,
        openCreateOperationModal,
        openOperationTemplatesModal,

        openScheduleInterviewModal,
        openEditInterviewModal,
        openConductInterviewModal,
        openAddProspectModal,
        openAddCaseFileModal,
        openSecurityVettingModal,
        openGenericCaseFileModal,
        openCaseDetailsModal,
        openRequestClearanceModal,
        openCreatePositionModal,
        openIssueEamModal,

        openWindow,

        // Intel (multi-window)
        isCreateIntelWindowOpen, setIsCreateIntelWindowOpen,
        openIntelReports,
        openCreateIntelWindow,
        openIntelReportWindow,
        closeIntelReportWindow,
        intelRefreshTrigger,
        triggerIntelRefresh,
        selectedIntelReport, setSelectedIntelReport,

        // Bulletin Modal
        showCreateBulletinModal, setShowCreateBulletinModal,

        // Window Minimization
        minimizedWindows,
        minimizeWindow,
        restoreWindow,
        closeMinimizedWindow,
    };

    return <ModalRegistryContext value={value}>{children}</ModalRegistryContext>;
};

export const useModalRegistry = () => {
    const context = use(ModalRegistryContext);
    if (!context) {
        throw new Error('useModalRegistry must be used within a ModalRegistryProvider');
    }
    return context;
};
