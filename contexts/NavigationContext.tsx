import React, { createContext, useState, useCallback, use } from 'react';
import {
    User,
    HydratedServiceRequest,
    OrganizationalUnit,
    Rank,
    Announcement,
    HydratedOperation,
    HydratedOperationTeam,
    HydratedOperationPosition,
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
    IntelBulletin,
    MirroredOperation,
} from '../types';

export interface NavigationContextType {
    activeView: string;
    setActiveView: (view: string) => void;
    isMobileSidebarOpen: boolean;
    setIsMobileSidebarOpen: (isOpen: boolean) => void;
    isSidebarCollapsed: boolean;
    setIsSidebarCollapsed: (isCollapsed: boolean) => void;

    // Search State
    globalSearchQuery: string;
    setGlobalSearchQuery: (query: string) => void;

    // Radio State
    isRadioOpen: boolean;
    setIsRadioOpen: (isOpen: boolean) => void;

    // Banner / Alert state
    eamMessage: string | null;
    setEamMessage: (message: string | null) => void;
    operationAlert: { message: string; senderName?: string; operationId?: string } | null;
    setOperationAlert: (alert: { message: string; senderName?: string; operationId?: string } | null) => void;

    // Duty toggle in-flight flag
    isTogglingDuty: boolean;
    setIsTogglingDuty: (isToggling: boolean) => void;

    // Selected Items
    selectedRequest: HydratedServiceRequest | null; setSelectedRequest: (request: HydratedServiceRequest | null) => void;
    selectedOperation: HydratedOperation | null; setSelectedOperation: (operation: HydratedOperation | null) => void;
    selectedMirroredOperation: MirroredOperation | null; setSelectedMirroredOperation: (mirror: MirroredOperation | null) => void;
    selectedWarrant: HydratedWarrant | null; setSelectedWarrant: (warrant: HydratedWarrant | null) => void;
    selectedBulletin: IntelBulletin | null; setSelectedBulletin: (bulletin: IntelBulletin | null) => void;
    selectedUser: User | null; setSelectedUser: (user: User | null) => void;
    selectedHRApplicant: HydratedHRApplication | null; setSelectedHRApplicant: (app: HydratedHRApplication | null) => void;
    selectedHRInterview: HydratedHRInterview | null; setSelectedHRInterview: (interview: HydratedHRInterview | null) => void;
    selectedCaseFile: HydratedHRApplication | null; setSelectedCaseFile: (file: HydratedHRApplication | null) => void;

    editingUnit: OrganizationalUnit | undefined; setEditingUnit: (unit: OrganizationalUnit | undefined) => void;
    editingRank: Rank | undefined; setEditingRank: (rank: Rank | undefined) => void;
    editingNotice: Announcement | undefined; setEditingNotice: (notice: Announcement | undefined) => void;
    editingRole: Role | undefined; setEditingRole: (role: Role | undefined) => void;
    editingLocation: Location | undefined; setEditingLocation: (location: Location | undefined) => void;
    editingTeam: HydratedOperationTeam | null; setEditingTeam: (team: HydratedOperationTeam | null) => void;
    editingPosition: HydratedOperationPosition | null; setEditingPosition: (position: HydratedOperationPosition | null) => void;
    teamForPositionModal: HydratedOperationTeam | null; setTeamForPositionModal: (team: HydratedOperationTeam | null) => void;
    editingExternalTool: ExternalTool | undefined; setEditingExternalTool: (tool: ExternalTool | undefined) => void;
    editingServiceType: ServiceTypeConfig | undefined; setEditingServiceType: (config: ServiceTypeConfig | undefined) => void;

    // HR Edit States
    editingJob: JobPosting | undefined; setEditingJob: (job: JobPosting | undefined) => void;
    applyingJob: JobPosting | undefined; setApplyingJob: (job: JobPosting | undefined) => void;
    editingTemplate: HRInterviewTemplate | undefined; setEditingTemplate: (template: HRInterviewTemplate | undefined) => void;
    editingInterview: HydratedHRInterview | undefined; setEditingInterview: (interview: HydratedHRInterview | undefined) => void;
    editingHRPosition: PersonnelPosition | undefined; setEditingHRPosition: (position: PersonnelPosition | undefined) => void;

    // Other State
    viewingMember: User | null; setViewingMember: (user: User | null) => void;
    selectedDossierTarget: string | null; setSelectedDossierTarget: (targetId: string | null) => void;

    // Navigation Helpers
    viewRequestDetails: (request: HydratedServiceRequest) => void;
    viewOperationDetails: (operation: HydratedOperation) => void;
    viewMirroredOperation: (mirror: MirroredOperation) => void;
    viewMemberProfile: (user: User) => void;
    viewUnitDetail: (unitId: number) => void;
    selectedUnitDetailId: number | null;
    viewDossier: (targetId: string) => void;
}

const NavigationContext = createContext<NavigationContextType | null>(null);

export const NavigationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [activeView, setActiveView] = useState('dashboard');
    const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
    const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
    const [globalSearchQuery, setGlobalSearchQuery] = useState('');
    const [isTogglingDuty, setIsTogglingDuty] = useState(false);
    const [eamMessage, setEamMessage] = useState<string | null>(null);
    const [operationAlert, setOperationAlert] = useState<{ message: string; senderName?: string; operationId?: string } | null>(null);

    // Radio State
    const [isRadioOpen, setIsRadioOpen] = useState(false);

    // Selected Data
    const [selectedRequest, setSelectedRequest] = useState<HydratedServiceRequest | null>(null);
    const [selectedOperation, setSelectedOperation] = useState<HydratedOperation | null>(null);
    const [selectedMirroredOperation, setSelectedMirroredOperation] = useState<MirroredOperation | null>(null);
    const [selectedWarrant, setSelectedWarrant] = useState<HydratedWarrant | null>(null);
    const [selectedBulletin, setSelectedBulletin] = useState<IntelBulletin | null>(null);
    const [selectedUser, setSelectedUser] = useState<User | null>(null);
    const [selectedHRApplicant, setSelectedHRApplicant] = useState<HydratedHRApplication | null>(null);
    const [selectedHRInterview, setSelectedHRInterview] = useState<HydratedHRInterview | null>(null);
    const [selectedCaseFile, setSelectedCaseFile] = useState<HydratedHRApplication | null>(null);

    const [editingUnit, setEditingUnit] = useState<OrganizationalUnit | undefined>(undefined);
    const [editingRank, setEditingRank] = useState<Rank | undefined>(undefined);
    const [editingNotice, setEditingNotice] = useState<Announcement | undefined>(undefined);
    const [editingRole, setEditingRole] = useState<Role | undefined>(undefined);
    const [editingLocation, setEditingLocation] = useState<Location | undefined>(undefined);
    const [editingTeam, setEditingTeam] = useState<HydratedOperationTeam | null>(null);
    const [editingPosition, setEditingPosition] = useState<HydratedOperationPosition | null>(null);
    const [teamForPositionModal, setTeamForPositionModal] = useState<HydratedOperationTeam | null>(null);
    const [editingExternalTool, setEditingExternalTool] = useState<ExternalTool | undefined>(undefined);
    const [editingServiceType, setEditingServiceType] = useState<ServiceTypeConfig | undefined>(undefined);

    // HR Edit Data
    const [editingJob, setEditingJob] = useState<JobPosting | undefined>(undefined);
    const [applyingJob, setApplyingJob] = useState<JobPosting | undefined>(undefined);
    const [editingTemplate, setEditingTemplate] = useState<HRInterviewTemplate | undefined>(undefined);
    const [editingInterview, setEditingInterview] = useState<HydratedHRInterview | undefined>(undefined);
    const [editingHRPosition, setEditingHRPosition] = useState<PersonnelPosition | undefined>(undefined);

    const [viewingMember, setViewingMember] = useState<User | null>(null);
    const [selectedDossierTarget, setSelectedDossierTarget] = useState<string | null>(null);

    // Org Chart → Unit Detail navigation: store the picked unit id and switch
    // the active view to the detail route.
    const [selectedUnitDetailId, setSelectedUnitDetailId] = useState<number | null>(null);

    const viewRequestDetails = useCallback((request: HydratedServiceRequest) => {
        setSelectedRequest(request);
        setActiveView('request-detail');
    }, []);

    const viewOperationDetails = useCallback((operation: HydratedOperation) => {
        setSelectedOperation(operation);
        setActiveView('operation-detail');
    }, []);

    const viewMirroredOperation = useCallback((mirror: MirroredOperation) => {
        setSelectedMirroredOperation(mirror);
        setActiveView('mirrored-operation-detail');
    }, []);

    const viewMemberProfile = useCallback((user: User) => {
        setViewingMember(user);
        setActiveView('member-record');
    }, []);

    const viewUnitDetail = useCallback((unitId: number) => {
        setSelectedUnitDetailId(unitId);
        setActiveView('unit-detail');
    }, []);

    const viewDossier = useCallback((targetId: string) => {
        setSelectedDossierTarget(targetId);
        setActiveView('intel');
    }, []);

    const value: NavigationContextType = {
        activeView, setActiveView,
        isMobileSidebarOpen, setIsMobileSidebarOpen,
        isSidebarCollapsed, setIsSidebarCollapsed,
        globalSearchQuery, setGlobalSearchQuery,
        isRadioOpen, setIsRadioOpen,

        eamMessage, setEamMessage,
        operationAlert, setOperationAlert,
        isTogglingDuty, setIsTogglingDuty,

        selectedRequest, setSelectedRequest,
        selectedOperation, setSelectedOperation,
        selectedMirroredOperation, setSelectedMirroredOperation,
        selectedWarrant, setSelectedWarrant,
        selectedBulletin, setSelectedBulletin,
        selectedUser, setSelectedUser,
        selectedHRApplicant, setSelectedHRApplicant,
        selectedHRInterview, setSelectedHRInterview,
        selectedCaseFile, setSelectedCaseFile,

        editingUnit, setEditingUnit,
        editingRank, setEditingRank,
        editingNotice, setEditingNotice,
        editingRole, setEditingRole,
        editingLocation, setEditingLocation,
        editingTeam, setEditingTeam,
        editingPosition, setEditingPosition,
        teamForPositionModal, setTeamForPositionModal,
        editingExternalTool, setEditingExternalTool,
        editingServiceType, setEditingServiceType,

        editingJob, setEditingJob,
        applyingJob, setApplyingJob,
        editingTemplate, setEditingTemplate,
        editingInterview, setEditingInterview,
        editingHRPosition, setEditingHRPosition,

        viewingMember, setViewingMember,
        selectedDossierTarget, setSelectedDossierTarget,

        viewRequestDetails,
        viewOperationDetails,
        viewMirroredOperation,
        viewMemberProfile,
        viewUnitDetail,
        selectedUnitDetailId,
        viewDossier,
    };

    return <NavigationContext value={value}>{children}</NavigationContext>;
};

export const useNavigation = () => {
    const context = use(NavigationContext);
    if (!context) {
        throw new Error('useNavigation must be used within a NavigationProvider');
    }
    return context;
};
