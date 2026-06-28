

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useConfig } from '../../../contexts/ConfigContext';
import { useHR } from '../../../contexts/HRContext';

import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { HydratedHRApplication, ApplicationStatus, VettingChecklist, DossierData, TransferRequestStatus, WarrantStatus, ConductRecordType, formatReferralSource } from '../../../types';
import IntelligenceReportCard from '../intel/IntelligenceReportCard';
import { useNotification } from '../../../contexts/NotificationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

interface UnifiedCaseFileViewProps {
    applicationId: string;
    onBack: () => void;
}

const defaultChecklist: VettingChecklist = {
    rsiProfile: 'pending',
    orgHistory: 'pending',
    internalRecord: 'pending',
    interview: 'pending'
};

// Unique sentinels distinct from every real value, used to force the first render
// to consider each render-time "adjust state" seed exactly once (mirroring the way
// the old seeding effects always ran once on mount).
const CLEARANCE_SEED_SENTINEL = Symbol('clearanceSeedInitial');
const CASE_FILE_SYNC_SENTINEL = Symbol('caseFileSyncInitial');

// Hoisted to module scope (was nested in the view): pure presentational dot,
// closes over no parent state.
const StatusDot: React.FC<{ status: string }> = ({ status }) => {
    let color = 'bg-slate-600';
    if (status === 'clear') color = 'bg-green-500 shadow-green-500/50';
    if (status === 'flagged') color = 'bg-red-500 shadow-red-500/50';
    return <div className={`w-2 h-2 rounded-full ${color} shadow-[0_0_8px]`} />;
};

const UnifiedCaseFileView: React.FC<UnifiedCaseFileViewProps> = ({ applicationId, onBack }) => {
    const { rpcAction, refreshHR, refreshMainState, optimisticUpdate, isFetching, fetchUserDetail } = useData();
    const {
        members, allUsers, securityClearances, limitingMarkers, units, roles, ranks,
        updateUserClearance, promoteUserToMember, updateUserRecord,
    } = useMembers();
    const { hrConfig } = useConfig();
    const { hrApplicants, hrInterviews, hrJobs, hrTransfers } = useHR();
    const { currentUser, hasPermission } = useAuth();
    const fmt = useFormatDate();
    const { addToast, confirm } = useNotification();
    const { openScheduleInterviewModal, openEditInterviewModal, openConductInterviewModal, openWindow, openCaseDetailsModal } = useModalRegistry();

    // Core State
    const [caseFile, setCaseFile] = useState<HydratedHRApplication | undefined>(undefined);
    const [activeTab, setActiveTab] = useState<'overview' | 'background' | 'interviews' | 'log' | 'adjudication' | 'admin'>('overview');
    const [isLoading, setIsLoading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isAssigning, setIsAssigning] = useState(false);

    // Log State
    const [localLogs, setLocalLogs] = useState<any[]>([]);

    // Form States
    const [newNote, setNewNote] = useState('');
    const [finalNotes, setFinalNotes] = useState('');
    const [dossier, setDossier] = useState<DossierData | null>(null);
    const [resetStatus, setResetStatus] = useState<ApplicationStatus | ''>('');

    // Interview Management State
    const [isReassigning, setIsReassigning] = useState<string | null>(null);
    const [newInterviewerId, setNewInterviewerId] = useState('');

    // Vetting Specific State
    const [vettingData, setVettingData] = useState<{ checks: VettingChecklist, comments: Record<string, string> }>({
        checks: { ...defaultChecklist },
        comments: {}
    });
    const [vettingLoading, setVettingLoading] = useState(true);

    // Security/Transfer Outcome State
    const [selectedLevelId, setSelectedLevelId] = useState<string>('');
    const [selectedMarkers, setSelectedMarkers] = useState<Set<number>>(() => new Set());

    // Hire Assignment State (unit, rank, clearance for new hires)
    const [hireUnitId, setHireUnitId] = useState<string>('');
    const [hireRankId, setHireRankId] = useState<string>('');
    const [hireClearanceLevelId, setHireClearanceLevelId] = useState<string>('');
    const [hireClearanceMarkers, setHireClearanceMarkers] = useState<Set<number>>(() => new Set());

    // --- INITIALIZATION ---

    // Sync caseFile from the realtime applicant list, merging in the linked
    // interviews. This has retention semantics: caseFile is only *replaced* when the
    // applicant is present in the realtime list, and is never cleared on a transient
    // absence (a pure useMemo would flash "not found" during a refetch gap). Because
    // of that retention it cannot be a plain derived value, so it stays in state and
    // is adjusted during render via a prev-input tracker (React re-renders before
    // paint). The tracker keys on the same inputs the old effect depended on
    // [hrApplicants, hrInterviews, applicationId], so a fresh merged object is
    // produced on exactly the same changes — preserving downstream memo invalidation
    // cadence. The sentinel forces the first render to consider the seed once, the
    // way the effect always ran on mount.
    const [prevCaseFileInputs, setPrevCaseFileInputs] = useState<{
        hrApplicants: typeof hrApplicants | typeof CASE_FILE_SYNC_SENTINEL;
        hrInterviews: typeof hrInterviews;
        applicationId: string;
    }>({ hrApplicants: CASE_FILE_SYNC_SENTINEL, hrInterviews, applicationId });
    if (
        !Object.is(prevCaseFileInputs.hrApplicants, hrApplicants) ||
        !Object.is(prevCaseFileInputs.hrInterviews, hrInterviews) ||
        !Object.is(prevCaseFileInputs.applicationId, applicationId)
    ) {
        setPrevCaseFileInputs({ hrApplicants, hrInterviews, applicationId });
        if (applicationId) {
            const found = hrApplicants.find(a => a.id === applicationId);
            if (found) {
                // Merge with interviews found in global state
                const linkedInterviews = hrInterviews.filter(i => i.applicationId === applicationId);
                setCaseFile({ ...found, interviews: linkedInterviews });
            }
        }
    }

    // Vetting data is lazy-loaded per case (it's recruiter-grade PII, not shipped in
    // the bulk list). vettingLoading guards the save handler so a save fired before
    // the fetch lands can't overwrite the real record with the empty default.
    //
    // The synchronous reset (loading -> true, data -> empty default) that clears the
    // prior case's PII before the async fetch lands runs here during render via a
    // prev-key tracker on the fetch inputs (applicationId / rpcAction). React
    // re-renders before paint, so this is equivalent to the old effect's pre-fetch
    // reset, but keeps a synchronous setState out of the effect body. Guarded on a
    // truthy applicationId, matching the old effect's early return.
    const [prevVettingKey, setPrevVettingKey] = useState<{ id: string; rpc: typeof rpcAction }>({ id: applicationId, rpc: rpcAction });
    if (applicationId && (applicationId !== prevVettingKey.id || rpcAction !== prevVettingKey.rpc)) {
        setPrevVettingKey({ id: applicationId, rpc: rpcAction });
        setVettingLoading(true);
        setVettingData({ checks: { ...defaultChecklist }, comments: {} });
    }
    useEffect(() => {
        if (!applicationId) return;
        let cancelled = false;
        (async () => {
            try {
                const loaded = (await rpcAction('hr:get_application_data', { id: applicationId })) as { checks?: Partial<VettingChecklist>; comments?: Record<string, string> } | null;
                if (cancelled) return;
                const d = loaded || {};
                setVettingData({
                    checks: { ...defaultChecklist, ...(d.checks || {}) },
                    comments: d.comments || {}
                });
            } catch (e) {
                if (!cancelled) console.error(e);
            } finally {
                if (!cancelled) setVettingLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [applicationId, rpcAction]);

    // Fetch the intel dossier only when the target handle changes — keeping it
    // in the case-file effect would re-fire on every realtime tick.
    const dossierTarget = caseFile?.rsiHandle;
    useEffect(() => {
        if (!dossierTarget) return;
        let cancelled = false;
        rpcAction('intel:get_dossier', { targetId: dossierTarget })
            .then(d => { if (!cancelled) setDossier(d); })
            .catch(console.error);
        return () => { cancelled = true; };
    }, [dossierTarget, rpcAction]);

    const fetchLogs = useCallback(async () => {
        if (!applicationId) return;
        try {
            const logs = await rpcAction('hr:get_application_logs', { applicationId });
            setLocalLogs(logs || []);
        } catch (e) {
            console.error("Failed to fetch logs", e);
        }
    }, [applicationId, rpcAction]);

    useEffect(() => {
        void (async () => { await fetchLogs(); })();
    }, [fetchLogs]);

    // --- DERIVED DATA ---

    // The roster cache (allUsers) trims heavy nested arrays (limitingMarkers,
    // certifications, commendations, conductRecord) for egress reasons. This
    // view reads all of them to seed clearance/marker save state and to render
    // the awards/conduct panels — saving with stale empty arrays would clear
    // the user's actual records. Lazy-fetch the fully-hydrated record.
    const cachedLinkedMember = useMemo(() => allUsers.find(u => u.id === caseFile?.linkedUserId), [allUsers, caseFile]);
    const [fullLinkedMember, setFullLinkedMember] = useState<typeof cachedLinkedMember | null>(null);
    // Clear the lazily-fetched, fully-hydrated member to null the moment the case
    // unlinks its user, so stale PII is dropped before any re-fetch. Done during
    // render via a prev-key tracker (React re-renders before paint) so no
    // synchronous setState sits in the effect. Only resets when the new linked
    // user is absent — a truthy A->B change keeps showing A until B's fetch lands,
    // exactly as the previous effect did.
    const linkedUserId = caseFile?.linkedUserId;
    const [prevLinkedUserId, setPrevLinkedUserId] = useState(linkedUserId);
    if (linkedUserId !== prevLinkedUserId) {
        setPrevLinkedUserId(linkedUserId);
        if (!linkedUserId) setFullLinkedMember(null);
    }
    useEffect(() => {
        if (!caseFile?.linkedUserId) return;
        let cancelled = false;
        (async () => {
            const full = await fetchUserDetail(caseFile.linkedUserId!);
            if (!cancelled && full) setFullLinkedMember(full as any);
        })();
        return () => { cancelled = true; };
    }, [caseFile?.linkedUserId, cachedLinkedMember, fetchUserDetail]);
    const linkedMember = fullLinkedMember || cachedLinkedMember;
    const userRecord = linkedMember;

    // Check for other open investigations (Internal Case Files)
    const activeInvestigations = useMemo(() => {
        if (!caseFile || !caseFile.linkedUserId) return [];
        return hrApplicants.filter(a =>
            a.linkedUserId === caseFile.linkedUserId &&
            a.referralSource === 'INTERNAL_CASE' &&
            a.id !== caseFile.id
        );
    }, [hrApplicants, caseFile]);

    // Determine Case Type configuration
    const caseConfig = useMemo(() => {
        const source = caseFile?.referralSource || '';

        // Priority 1: Check for Internal Job/Promotion
        if (source === 'INTERNAL_JOB' || source.startsWith('Internal Application:') || source.startsWith('Job:')) {
            return { type: 'JOB', color: 'blue', icon: 'fa-briefcase', label: 'Internal Promotion' };
        }

        // Priority 2: Security Vetting
        if (source === 'SECURITY_VETTING' || source.includes('Security') || source.includes('Clearance')) {
            return { type: 'VETTING', color: 'indigo', icon: 'fa-shield-halved', label: 'Security Clearance' };
        }

        // Priority 3: Transfers
        if (source === 'INTERNAL_TRANSFER') {
            return { type: 'TRANSFER', color: 'amber', icon: 'fa-right-left', label: 'Unit Transfer' };
        }

        // Priority 4: Internal Affairs / Investigations
        if (source === 'INTERNAL_CASE') {
            return { type: 'INTERNAL', color: 'red', icon: 'fa-folder-closed', label: 'Internal Affairs' };
        }

        // Default: Recruitment
        return { type: 'RECRUITMENT', color: 'sky', icon: 'fa-user-plus', label: formatReferralSource(source) };
    }, [caseFile]);

    const isCompleted = useMemo(() => {
        return caseFile?.status === ApplicationStatus.Hired || caseFile?.status === ApplicationStatus.Rejected || caseFile?.status === ApplicationStatus.Accepted;
    }, [caseFile?.status]);

    const availableOfficers = useMemo(() => {
        return members.filter(m => m.permissions.includes('hr:recruiter') || m.permissions.includes('hr:admin') || m.permissions.includes('hr:manager'));
    }, [members]);

    // Linked Transfer Request (if applicable)
    const transferRequest = useMemo(() => {
        if (caseConfig.type !== 'TRANSFER' || !caseFile?.linkedUserId) return null;
        return hrTransfers.find(t => t.userId === caseFile.linkedUserId && t.status === 'Pending');
    }, [caseFile, hrTransfers, caseConfig.type]);

    // Requested Clearance Level (if applicable)
    const requestedLevel = useMemo(() => {
        if (caseConfig.type !== 'VETTING' || !caseFile?.notes) return null;
        const match = caseFile.notes.match(/Level (\d+)/i);
        if (match && match[1]) {
            const lvl = parseInt(match[1]);
            return securityClearances.find(c => c.level === lvl);
        }
        return null;
    }, [caseFile, securityClearances, caseConfig.type]);

    // Requested markers parsed from case notes (e.g. "REQUESTED MARKERS: CODE1, CODE2")
    const requestedMarkerIds = useMemo(() => {
        const notes = caseFile?.notes;
        if (caseConfig.type !== 'VETTING' || !notes) return [];
        const match = notes.match(/REQUESTED MARKERS:\s*(.+)/i);
        if (!match || !match[1]) return [];
        const codes = match[1].split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
        return limitingMarkers.filter(m => codes.includes(m.code?.toUpperCase())).map(m => m.id);
    }, [caseFile?.notes, caseConfig.type, limitingMarkers]);

    // Linked Job Posting (for JOB case types)
    const linkedJob = useMemo(() => {
        if (caseConfig.type !== 'JOB') return null;
        const source = caseFile?.referralSource || '';
        const match = source.match(/(?:Internal Application|Job):\s*(.+)/i);
        const title = match?.[1]?.trim();
        const job = title ? hrJobs.find(j => j.title === title) : null;
        return { job, title: job?.title || title || source };
    }, [caseFile?.referralSource, caseConfig.type, hrJobs]);

    // Pre-fill clearance fields: for VETTING use requested values, otherwise use
    // current member values. This seeds *editable* form state (the user then edits
    // it independently), so it is not a pure render-time value. It is performed via
    // the React "adjust state during render" pattern with a prev-input tracker that
    // reproduces the old effect exactly: the seed is reconsidered only when one of
    // the tracked inputs changes (mirroring the effect's dependency array), and is
    // applied only while the one-shot guard `linkedMember && !selectedLevelId`
    // holds. Reconsidering only on input change is what prevents a render loop when
    // the seed resolves to an empty level (the same role the dep array played).
    // Security-sensitive: fields, values, the VETTING/non-VETTING branch and the
    // guard are preserved byte-for-byte from the previous effect.
    // Sentinel ensures the first render "considers" the seed exactly once, the way
    // the effect always ran once on mount (a tracker seeded with the real current
    // values would skip that first consideration).
    const [prevClearanceSeedInputs, setPrevClearanceSeedInputs] = useState<{
        linkedMember: typeof linkedMember | typeof CLEARANCE_SEED_SENTINEL;
        selectedLevelId: string | typeof CLEARANCE_SEED_SENTINEL;
        caseType: string;
        requestedLevel: typeof requestedLevel;
        requestedMarkerIds: typeof requestedMarkerIds;
    }>({ linkedMember: CLEARANCE_SEED_SENTINEL, selectedLevelId: CLEARANCE_SEED_SENTINEL, caseType: caseConfig.type, requestedLevel, requestedMarkerIds });
    const clearanceSeedInputsChanged =
        !Object.is(prevClearanceSeedInputs.linkedMember, linkedMember) ||
        !Object.is(prevClearanceSeedInputs.selectedLevelId, selectedLevelId) ||
        !Object.is(prevClearanceSeedInputs.caseType, caseConfig.type) ||
        !Object.is(prevClearanceSeedInputs.requestedLevel, requestedLevel) ||
        !Object.is(prevClearanceSeedInputs.requestedMarkerIds, requestedMarkerIds);
    if (clearanceSeedInputsChanged) {
        setPrevClearanceSeedInputs({ linkedMember, selectedLevelId, caseType: caseConfig.type, requestedLevel, requestedMarkerIds });
        if (linkedMember && !selectedLevelId) {
            if (caseConfig.type === 'VETTING') {
                setSelectedLevelId(requestedLevel?.id.toString() || linkedMember.clearanceLevel?.id.toString() || '');
                const existingIds = linkedMember.limitingMarkers?.map(m => m.id) || [];
                setSelectedMarkers(new Set([...existingIds, ...requestedMarkerIds]));
            } else {
                setSelectedLevelId(linkedMember.clearanceLevel?.id.toString() || '');
                setSelectedMarkers(new Set(linkedMember.limitingMarkers?.map(m => m.id)));
            }
        }
    }

    // --- ACTIONS ---

    const handleAssignOfficer = async (newId: string) => {
        if (!caseFile) return;
        setIsAssigning(true);
        const recruiterId = newId ? parseInt(newId) : undefined;
        try {
            await rpcAction('hr:assign_recruiter', { id: caseFile.id, recruiterId, userId: currentUser?.id });
            await refreshHR();
            fetchLogs();
        } catch (e) {
            console.error("Failed to assign officer", e);
        } finally {
            setIsAssigning(false);
        }
    };

    const handleAddNote = async () => {
        if (!caseFile || !newNote.trim()) return;
        setIsSaving(true);
        try {
            await rpcAction('hr:add_log', {
                applicationId: caseFile.id,
                message: newNote.trim(),
                actionType: 'NOTE',
                userId: currentUser?.id
            });
            setNewNote('');
            await refreshHR();
            fetchLogs();
        } finally {
            setIsSaving(false);
        }
    };

    const handleSaveProgress = async () => {
        if (!caseFile || vettingLoading) return; // don't persist the empty default before the fetch lands
        setIsSaving(true);
        try {
            await rpcAction('hr:update_application_data', { id: caseFile.id, data: vettingData });
            await refreshHR();
        } catch (e) {
            console.error("Failed to save progress", e);
        } finally {
            setIsSaving(false);
        }
    };

    const handleDecision = async (decision: 'Approve' | 'Deny') => {
        if (!caseFile) return;

        let confirmMsg = `Are you sure you want to ${decision.toUpperCase()} this case?`;
        if (caseConfig.type === 'TRANSFER') confirmMsg = `Are you sure you want to ${decision.toUpperCase()} this transfer request? This will move the member to the new unit.`;
        if (caseConfig.type === 'VETTING') confirmMsg = `Are you sure you want to ${decision.toUpperCase()} this clearance request? This will update the member's security profile.`;
        if (caseConfig.type === 'JOB') confirmMsg = `Are you sure you want to ${decision.toUpperCase()} this job application? This will mark the candidate as hired/promoted.`;

        const confirmDecision = await confirm({ title: 'Confirm Decision', message: confirmMsg, confirmText: decision, variant: 'danger' });
        if (!confirmDecision) return;

        setIsSaving(true);
        try {
            // Pre-flight: Promote website applicant to Member before changing status
            const promoteTargetId = linkedMember?.id ?? caseFile.linkedUserId;
            if (decision === 'Approve' && caseFile.referralSource === 'WEBSITE_APPLICATION' && promoteTargetId) {
                try {
                    await promoteUserToMember(promoteTargetId);
                } catch (err: any) {
                    console.error(err);
                    addToast("Promotion Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: err?.message || "Failed to promote the user to Member." });
                    setIsSaving(false);
                    return; // Abort — do not change case status
                }
            }

            const status = decision === 'Approve'
                ? (['RECRUITMENT', 'JOB'].includes(caseConfig.type) ? ApplicationStatus.Hired : ApplicationStatus.Accepted)
                : ApplicationStatus.Rejected;

            // Optimistic Update
            optimisticUpdate('hr_applications', caseFile.id, { status }, 'update');

            // 1. Update Case Status
            await rpcAction('hr:update_app_status', {
                id: caseFile.id,
                status,
                notes: finalNotes || `Decision: ${decision}`,
                userId: currentUser?.id
            });

            // 2. Type-Specific Actions
            // Apply clearance upgrades for VETTING approvals only
            if (decision === 'Approve' && linkedMember && caseConfig.type === 'VETTING') {
                const levelId = selectedLevelId ? parseInt(selectedLevelId) : null;
                await updateUserClearance(linkedMember.id, levelId, Array.from(selectedMarkers));
            }

            // Apply hire assignments (unit, rank, clearance) for RECRUITMENT approvals
            if (decision === 'Approve' && caseConfig.type === 'RECRUITMENT') {
                const hireTargetId = linkedMember?.id ?? caseFile.linkedUserId;
                if (hireTargetId) {
                    const userUpdates: Record<string, any> = {};
                    if (hireUnitId) userUpdates.unitId = parseInt(hireUnitId);
                    if (hireRankId) userUpdates.rankId = parseInt(hireRankId);
                    if (Object.keys(userUpdates).length > 0) {
                        await updateUserRecord(hireTargetId, userUpdates);
                    }
                    if (hireClearanceLevelId) {
                        await updateUserClearance(hireTargetId, parseInt(hireClearanceLevelId), Array.from(hireClearanceMarkers));
                    }
                }
            }

            // Process job approvals — update member's primary position
            if (decision === 'Approve' && caseConfig.type === 'JOB') {
                await rpcAction('hr:process_job_approval', { applicationId: caseFile.id });
            }

            // Process transfer requests
            if (caseConfig.type === 'TRANSFER' && transferRequest) {
                await rpcAction('hr:process_transfer', {
                    id: transferRequest.id,
                    status: decision === 'Approve' ? TransferRequestStatus.Approved : TransferRequestStatus.Denied,
                    notes: `Decision by ${currentUser?.name}`
                });
            }

            await refreshHR();
            // Hiring modifies user data (role, probation, unit) — refresh main state too
            if (decision === 'Approve' && ['RECRUITMENT', 'JOB'].includes(caseConfig.type)) {
                await refreshMainState();
            }
            fetchLogs();
            onBack();
        } catch (err) {
            console.error(err);
            addToast("Decision Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to process the decision." });
        } finally {
            setIsSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!caseFile) return;
        const confirmedDelete = await confirm({ title: 'Delete Case File', message: 'Permanently delete this case file? This cannot be undone.', confirmText: 'Delete', variant: 'danger' });
        if (!confirmedDelete) return;
        setIsDeleting(true);
        try {
            optimisticUpdate('hr_applications', caseFile.id, {}, 'delete');
            await rpcAction('hr:delete_application', { id: caseFile.id });
            await refreshHR();
            onBack();
        } catch (e) {
            console.error(e);
            setIsDeleting(false);
        }
    };

    const handleResetStatus = async () => {
        if (!caseFile || !resetStatus) return;
        const confirmReset = await confirm({ title: 'Status Override', message: `Force reset case status to ${resetStatus}?`, confirmText: 'Update Status', variant: 'danger' });
        if (!confirmReset) return;
        setIsSaving(true);
        try {
            await rpcAction('hr:update_app_status', {
                id: caseFile.id,
                status: resetStatus,
                userId: currentUser?.id,
                notes: `System Override: Status reset to ${resetStatus} by ${currentUser?.name}`
            });
            await refreshHR();
            fetchLogs();
            setResetStatus('');
        } catch (e) {
            console.error(e);
            addToast("Reset Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to reset the case status." });
        } finally {
            setIsSaving(false);
        }
    };

    const handleReassignInterview = async (interviewId: string) => {
        if (!newInterviewerId) return;
        setIsLoading(true);
        try {
            await rpcAction('hr:update_interview_interviewer', {
                interviewId,
                newInterviewerId: parseInt(newInterviewerId),
                userId: currentUser?.id
            });
            setIsReassigning(null);
            setNewInterviewerId('');
            await refreshHR();
            fetchLogs();
        } catch (e) {
            console.error("Failed to reassign interview", e);
            addToast("Reassign Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to reassign the interview." });
        } finally {
            setIsLoading(false);
        }
    };

    const handleReopenInterview = async (interviewId: string) => {
        const confirmedReopen = await confirm({ title: 'Reopen Interview', message: 'Are you sure you want to reopen this interview? Status will be reset to Scheduled.', confirmText: 'Reopen', variant: 'danger' });
        if (!confirmedReopen) return;
        setIsLoading(true);
        try {
            await rpcAction('hr:reopen_interview', { interviewId, userId: currentUser?.id });
            await refreshHR();
            fetchLogs();
        } catch (e) {
            console.error("Failed to reopen interview", e);
        } finally {
            setIsLoading(false);
        }
    }

    const handleDeleteInterview = async (interviewId: string) => {
        const confirmedDelete2 = await confirm({ title: 'Delete Interview', message: 'Are you sure you want to delete this interview record?', confirmText: 'Delete', variant: 'danger' });
        if (!confirmedDelete2) return;
        setIsLoading(true);
        try {
            optimisticUpdate('hr_interviews', interviewId, {}, 'delete');
            await rpcAction('hr:delete_interview', { interviewId, userId: currentUser?.id });
            await refreshHR();
            fetchLogs();
        } catch (e) {
            console.error("Failed to delete interview", e);
            addToast("Delete Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to delete the interview." });
        } finally {
            setIsLoading(false);
        }
    };

    const updateCheck = (key: keyof VettingChecklist, status: 'pending' | 'clear' | 'flagged') => {
        setVettingData(prev => ({ ...prev, checks: { ...prev.checks, [key]: status } }));
    };

    const updateComment = (key: string, value: string) => {
        setVettingData(prev => ({ ...prev, comments: { ...prev.comments, [key]: value } }));
    };

    const toggleMarker = (id: number) => {
        if (isCompleted) return;
        setSelectedMarkers(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    // --- RENDER HELPERS ---

    if (!caseFile) return <div className="p-12 text-center text-slate-500 italic">Case file not found or access denied.</div>;

    const notesList = localLogs.filter(l => l.actionType === 'NOTE');
    const getThemeColor = (opacity = '100') => {
        const c = caseConfig.color;
        if (c === 'sky') return `text-sky-400 border-sky-500/${opacity} bg-sky-500/${Number(opacity) / 2}`;
        if (c === 'indigo') return `text-indigo-400 border-indigo-500/${opacity} bg-indigo-500/${Number(opacity) / 2}`;
        if (c === 'amber') return `text-amber-400 border-amber-500/${opacity} bg-amber-500/${Number(opacity) / 2}`;
        if (c === 'red') return `text-red-400 border-red-500/${opacity} bg-red-500/${Number(opacity) / 2}`;
        if (c === 'blue') return `text-blue-400 border-blue-500/${opacity} bg-blue-500/${Number(opacity) / 2}`;
        return `text-slate-400 border-slate-500/${opacity} bg-slate-500/${Number(opacity) / 2}`;
    };

    const canManage = hasPermission('hr:admin') || hasPermission('hr:manager');
    const canRecruit = hasPermission('hr:recruiter');
    const inputClass = "w-full bg-slate-900/60 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/50 outline-hidden transition-all resize-none";

    return (
        <div className="flex flex-col h-full bg-slate-950 animate-fade-in">
            {/* Hero Header */}
            <div className="shrink-0 relative overflow-hidden border-b border-white/5 bg-linear-to-b from-emerald-950/25 via-slate-950/80 to-slate-950 z-10">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-emerald-500/10 rounded-full blur-[120px] pointer-events-none" aria-hidden />
                <div className="relative p-4 md:p-6 flex justify-between items-center">
                <div className="flex items-center gap-4 overflow-hidden">
                    <button onClick={onBack} className="w-9 h-9 shrink-0 flex items-center justify-center rounded-lg bg-slate-900/60 border border-slate-700 text-slate-400 hover:text-white hover:border-emerald-500/40 hover:bg-emerald-500/10 transition-all">
                        <i className="fa-solid fa-arrow-left text-sm"></i>
                    </button>
                    <div className="flex items-center gap-3 md:gap-4 overflow-hidden">
                        <div className={`w-10 h-10 md:w-12 md:h-12 rounded-lg flex items-center justify-center border shrink-0 ${getThemeColor('30')}`}>
                            <i className={`fa-solid ${caseConfig.icon} text-xl md:text-2xl`}></i>
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-lg md:text-2xl font-black text-white tracking-tight truncate">{caseFile.applicantName}</h2>
                            <div className="flex flex-col md:flex-row md:items-center gap-1 md:gap-2 mt-0.5">
                                <span className="text-slate-400 text-[10px] md:text-xs font-mono uppercase tracking-widest">CASE · {caseFile.id.split('-')[0].toUpperCase()}</span>
                                <span className="text-slate-600 text-[10px] md:text-xs hidden md:inline">·</span>
                                <span className={`text-[10px] md:text-xs font-black uppercase tracking-widest ${getThemeColor('100').split(' ')[0]}`}>{caseConfig.label}</span>
                                {isFetching['hr'] && (
                                    <span className="ml-2 text-emerald-300 animate-pulse text-[10px] font-bold flex items-center gap-1">
                                        <i className="fa-solid fa-arrows-rotate fa-spin"></i> Syncing...
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {!isCompleted && (
                        <button
                            onClick={handleSaveProgress}
                            disabled={isSaving || vettingLoading}
                            className="hidden md:flex text-[10px] bg-slate-700 hover:bg-slate-600 text-white px-4 py-2 rounded-lg font-bold uppercase transition-colors shadow-xs active:scale-95 whitespace-nowrap items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {(isSaving || vettingLoading) ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-floppy-disk"></i> Save Progress</>}
                        </button>
                    )}
                    <span className={`px-2.5 py-0.5 rounded text-[10px] font-black uppercase tracking-wider border ${caseFile.status === ApplicationStatus.Hired || caseFile.status === ApplicationStatus.Accepted ? 'bg-green-500/10 text-green-400 border-green-500/30' :
                        caseFile.status === ApplicationStatus.Rejected ? 'bg-red-500/10 text-red-400 border-red-500/30' :
                            'bg-slate-500/10 text-slate-400 border-slate-500/30'
                        }`}>
                        {caseFile.status}
                    </span>
                </div>
                </div>
            </div>

            <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">

                {/* Sidebar Nav */}
                <div className="hidden md:flex w-60 bg-slate-900/40 border-r border-slate-800/60 flex-col shrink-0">
                    <div className="p-3 space-y-0.5">
                        <p className="px-3 text-[10px] font-black text-slate-500 uppercase tracking-[0.2em] mb-2">Case Sections</p>
                        {[
                            { id: 'overview', label: 'Overview', icon: 'fa-file-contract' },
                            { id: 'background', label: 'Background', icon: 'fa-magnifying-glass' },
                            { id: 'interviews', label: 'Interviews', icon: 'fa-microphone-lines' },
                            { id: 'log', label: 'Audit Log', icon: 'fa-list-ul' },
                            { id: 'adjudication', label: 'Adjudication', icon: 'fa-gavel' }
                        ].map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id as any)}
                                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all duration-150 ${activeTab === tab.id
                                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 shadow-xs shadow-emerald-900/20'
                                    : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-300 border border-transparent'
                                    }`}
                            >
                                <i className={`fa-solid ${tab.icon} w-4 text-center text-[10px]`}></i>
                                <span className="truncate">{tab.label}</span>
                            </button>
                        ))}
                        {canManage && (
                            <button
                                onClick={() => setActiveTab('admin')}
                                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[11px] font-black uppercase tracking-widest transition-all duration-150 mt-2 ${activeTab === 'admin'
                                    ? 'bg-red-500/15 text-red-300 border border-red-500/30 shadow-xs shadow-red-900/20'
                                    : 'text-slate-500 hover:bg-slate-800/60 hover:text-slate-300 border border-transparent'
                                    }`}
                            >
                                <i className="fa-solid fa-screwdriver-wrench w-4 text-center text-[10px]"></i>
                                <span className="truncate">Admin Actions</span>
                            </button>
                        )}
                    </div>
                </div>

                {/* Main Content */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-4 md:p-8 bg-slate-900/50">

                    {/* Mobile Nav */}
                    <div className="md:hidden mb-6 flex flex-col gap-4">
                        {!isCompleted && (
                            <button
                                onClick={handleSaveProgress}
                                disabled={isSaving || vettingLoading}
                                className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold text-xs uppercase px-4 py-3 rounded-lg flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {(isSaving || vettingLoading) ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-floppy-disk"></i> Save Progress</>}
                            </button>
                        )}
                        <div className="relative">
                            <select
                                value={activeTab}
                                onChange={(e) => setActiveTab(e.target.value as any)}
                                className="w-full bg-slate-900/60 border border-slate-700 rounded-lg p-3 text-white font-bold focus:ring-1 focus:ring-emerald-500/50 focus:border-emerald-500/40 outline-hidden appearance-none transition-all"
                            >
                                <option value="overview">Case Overview</option>
                                <option value="background">Background Check</option>
                                <option value="interviews">Interviews</option>
                                <option value="log">Audit Log</option>
                                <option value="adjudication">Adjudication</option>
                                {canManage && <option value="admin">Admin Actions</option>}
                            </select>
                            <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-slate-400">
                                <i className="fa-solid fa-chevron-down"></i>
                            </div>
                        </div>
                    </div>

                    {activeTab === 'overview' && (
                        <div className="max-w-4xl space-y-6">
                            {/* Data Card */}
                            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                <h3 className="text-lg font-bold text-white mb-4 border-b border-slate-700 pb-2">Case Details</h3>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div>
                                        <p className="text-xs text-slate-500 uppercase font-bold mb-1">RSI Handle</p>
                                        <p className="text-white font-mono text-lg">{caseFile.rsiHandle}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-slate-500 uppercase font-bold mb-1">Case Officer</p>
                                        <div className="flex gap-2 items-center">
                                            {caseFile.assignedRecruiter && <img src={caseFile.assignedRecruiter.avatarUrl} className="h-6 w-6 rounded-full object-cover shrink-0" alt="Recruiter" />}
                                            <select
                                                value={caseFile.assignedRecruiterId || ''}
                                                onChange={(e) => handleAssignOfficer(e.target.value)}
                                                className={`bg-slate-900/50 border border-slate-600 text-white text-xs rounded-sm p-2 flex-1 outline-hidden transition-opacity ${isAssigning ? 'opacity-50 cursor-wait' : ''}`}
                                                disabled={isCompleted || (!canManage && !canRecruit) || isAssigning}
                                            >
                                                <option value="">{isAssigning ? 'Assigning...' : 'Unassigned'}</option>
                                                {availableOfficers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                                            </select>
                                        </div>
                                    </div>

                                    {/* Context Specific Data */}
                                    {caseConfig.type === 'TRANSFER' && transferRequest && (
                                        <div className="col-span-1 md:col-span-2 bg-amber-900/10 p-4 rounded-sm border border-amber-500/20">
                                            <div className="flex justify-between items-center text-sm">
                                                <span>From: <strong>{linkedMember?.unit?.name || 'Unassigned'}</strong></span>
                                                <i className="fa-solid fa-arrow-right text-amber-500"></i>
                                                <span>To: <strong>{(transferRequest as any).targetUnit?.name}</strong></span>
                                            </div>
                                            <p className="text-xs text-slate-400 mt-2 italic">"{transferRequest.reason}"</p>
                                        </div>
                                    )}

                                    {caseConfig.type === 'VETTING' && (
                                        <div className="col-span-1 md:col-span-2 bg-indigo-900/10 p-4 rounded-sm border border-indigo-500/20">
                                            <div className="flex justify-between items-center text-sm">
                                                <span>Current: <strong>{linkedMember?.clearanceLevel?.name || 'None'}</strong></span>
                                                <i className="fa-solid fa-arrow-right text-indigo-500"></i>
                                                <span>Requested: <strong>{requestedLevel?.name || 'Review'}</strong></span>
                                            </div>
                                        </div>
                                    )}

                                    <div className="col-span-1 md:col-span-2">
                                        <p className="text-xs text-slate-500 uppercase font-bold mb-2">Initial Statement / Report</p>
                                        <div className="bg-slate-900/50 p-4 rounded-sm border border-slate-700 text-sm text-slate-300 font-mono whitespace-pre-wrap leading-relaxed">
                                            {caseFile.notes || "No initial report provided."}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Officer Notes */}
                            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6 flex flex-col h-[400px]">
                                <h3 className="text-lg font-bold text-white mb-4">Investigative Notes</h3>
                                <div className="flex-1 overflow-y-auto space-y-4 pr-2 custom-scrollbar mb-4">
                                    {notesList.map(note => (
                                        <div key={note.id} className="flex gap-3">
                                            <img src={note.user?.avatarUrl} className="w-8 h-8 rounded-full shrink-0 object-cover" alt="User" />
                                            <div className="bg-slate-700/30 border border-slate-600/50 rounded-lg p-3 text-sm text-slate-200 flex-1">
                                                <div className="flex justify-between items-center mb-1">
                                                    <span className="font-bold text-xs text-slate-400">{note.user?.name}</span>
                                                    <span className="text-[10px] text-slate-500">{fmt(note.createdAt)}</span>
                                                </div>
                                                <p className="whitespace-pre-wrap">{note.message}</p>
                                            </div>
                                        </div>
                                    ))}
                                    {notesList.length === 0 && <p className="text-slate-500 italic text-sm text-center mt-10">No additional notes recorded.</p>}
                                </div>
                                {!isCompleted && (
                                    <div className="border-t border-slate-700 pt-3">
                                        <textarea
                                            value={newNote}
                                            onChange={(e) => setNewNote(e.target.value)}
                                            className="w-full h-20 bg-slate-900/60 border border-slate-700 rounded-lg p-3 text-sm text-slate-300 focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/30 outline-hidden resize-none mb-2 transition-all"
                                            placeholder="Add a case note..."
                                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddNote(); } }}
                                        />
                                        <div className="flex justify-end">
                                            <button onClick={handleAddNote} disabled={isSaving || !newNote.trim()} className="text-xs bg-amber-600 text-white font-bold px-4 py-2 rounded-sm hover:bg-amber-500 transition-colors disabled:bg-slate-700 disabled:text-slate-500">
                                                {isSaving ? 'Sending...' : 'Add Note'}
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'background' && (
                        <div className="max-w-4xl space-y-6">

                            {/* Member Standing Summary */}
                            {userRecord && (
                                <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4 flex items-center gap-2">
                                        <i className="fa-solid fa-id-card-clip text-emerald-300"></i> Member Standing
                                    </h3>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-700 text-center">
                                            <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">Reputation Score</p>
                                            <p className={`text-2xl font-black ${userRecord.reputation >= 50 ? 'text-green-400' : 'text-amber-400'}`}>{userRecord.reputation}</p>
                                        </div>
                                        <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-700 text-center">
                                            <p className="text-[10px] text-slate-500 uppercase font-black tracking-widest mb-1">Client Satisfaction</p>
                                            <div className="flex items-center justify-center gap-1">
                                                <p className="text-2xl font-black text-emerald-300">{userRecord.averageRating?.toFixed(1) || 'N/A'}</p>
                                                <i className="fa-solid fa-star text-amber-400 text-xs mb-1"></i>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Vetting Checklist if Vetting Mode */}
                            {caseConfig.type === 'VETTING' && (
                                <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                    <h3 className="text-lg font-bold text-white mb-4">Vetting Checks</h3>
                                    <div className="space-y-4">
                                        {[
                                            { key: 'rsiProfile', label: 'RSI Profile Validation' },
                                            { key: 'orgHistory', label: 'Organization History Check' },
                                            { key: 'internalRecord', label: 'Internal Conduct Record' },
                                            { key: 'interview', label: 'Interview Assessment' }
                                        ].map((item) => (
                                            <div key={item.key} className="bg-slate-900/30 border border-slate-700/50 rounded-lg p-4 flex flex-col">
                                                <div className="flex justify-between items-center mb-3">
                                                    <h3 className="text-xs font-bold text-slate-300 uppercase">{item.label}</h3>
                                                    <div className="flex gap-1">
                                                        {['clear', 'flagged', 'pending'].map(status => (
                                                            <button
                                                                key={status}
                                                                onClick={() => {
                                                                    const newChecks = { ...vettingData.checks, [item.key]: status };
                                                                    setVettingData(prev => ({ ...prev, checks: newChecks }));
                                                                }}
                                                                className={`w-3 h-3 rounded-full transition-all ${vettingData.checks[item.key as keyof VettingChecklist] === status ? (status === 'clear' ? 'bg-green-500 ring-2 ring-green-500/30' : status === 'flagged' ? 'bg-red-500 ring-2 ring-red-500/30' : 'bg-slate-500') : 'bg-slate-800'}`}
                                                                title={status}
                                                                disabled={isCompleted}
                                                            />
                                                        ))}
                                                    </div>
                                                </div>
                                                <textarea
                                                    value={vettingData.comments[item.key] || ''}
                                                    onChange={(e) => updateComment(item.key, e.target.value)}
                                                    className={`${inputClass} flex-1 text-xs h-16`}
                                                    placeholder="Notes..."
                                                    disabled={isCompleted}
                                                />
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                <h3 className="text-lg font-bold text-white mb-4">Internal Affairs Check</h3>
                                {activeInvestigations.length > 0 ? (
                                    <div className="bg-red-900/20 border border-red-500/30 p-4 rounded-lg">
                                        <div className="flex items-center gap-3 text-red-400 font-bold mb-2">
                                            <i className="fa-solid fa-triangle-exclamation text-xl"></i>
                                            <span>Active Investigations Found</span>
                                        </div>
                                        <p className="text-sm text-red-200/70 mb-4">This candidate is currently subject to internal review. Proceed with caution.</p>
                                        <div className="space-y-2">
                                            {activeInvestigations.map(inv => (
                                                <div
                                                    key={inv.id}
                                                    onClick={() => openCaseDetailsModal(inv)}
                                                    className="bg-slate-900/60 p-3 rounded-sm flex justify-between items-center text-sm cursor-pointer hover:bg-slate-800 border border-transparent hover:border-red-500/50 transition-colors"
                                                >
                                                    <div>
                                                        <span className="text-white font-bold block">{inv.applicantName}</span>
                                                        <span className="text-xs text-slate-500">Case ID: {inv.id.split('-')[0]}</span>
                                                    </div>
                                                    <span className="text-amber-400 font-bold uppercase text-xs">View Details <i className="fa-solid fa-arrow-right ml-1"></i></span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="bg-green-900/10 border border-green-500/20 p-4 rounded-lg text-center">
                                        <i className="fa-solid fa-check-circle text-green-500 text-2xl mb-2"></i>
                                        <p className="text-green-300 font-bold">No Active Investigations</p>
                                        <p className="text-green-200/60 text-xs">Candidate has no open internal case files.</p>
                                    </div>
                                )}
                            </div>

                            {/* Internal Conduct */}
                            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                <h3 className="text-lg font-bold text-white mb-4">Conduct Record</h3>
                                {userRecord && userRecord.conductRecord && userRecord.conductRecord.length > 0 ? (
                                    <div className="space-y-3">
                                        {userRecord.conductRecord.map(rec => (
                                            <div key={rec.id} className="bg-slate-900/50 p-3 rounded-sm border border-slate-700 flex justify-between items-start">
                                                <div>
                                                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-sm uppercase ${rec.type === ConductRecordType.Infraction || rec.type === ConductRecordType.Warning ? 'bg-red-500/20 text-red-400' : 'bg-green-500/20 text-green-400'}`}>{rec.type}</span>
                                                    <p className="text-sm text-slate-300 mt-1">{rec.reason}</p>
                                                </div>
                                                <span className="text-[10px] text-slate-500 font-mono">{fmt(rec.createdAt)}</span>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="p-4 bg-green-900/10 border border-green-500/20 rounded-lg text-center">
                                        <p className="text-green-400 font-bold text-sm">Clean Record</p>
                                        <p className="text-green-300/70 text-xs">No internal conduct entries found on file.</p>
                                    </div>
                                )}
                            </div>

                            {/* Certifications & Commendations */}
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                    <h3 className="text-lg font-bold text-white mb-4">Certifications</h3>
                                    {userRecord?.certifications && userRecord.certifications.length > 0 ? (
                                        <ul className="space-y-2">
                                            {userRecord.certifications.map(c => (
                                                <li key={c.id} className="flex items-center gap-2 text-sm text-slate-300">
                                                    <i className="fa-solid fa-certificate text-green-400"></i> {c.name}
                                                </li>
                                            ))}
                                        </ul>
                                    ) : <p className="text-sm text-slate-500 italic">None.</p>}
                                </div>
                                <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                    <h3 className="text-lg font-bold text-white mb-4">Commendations</h3>
                                    {userRecord?.commendations && userRecord.commendations.length > 0 ? (
                                        <ul className="space-y-2">
                                            {userRecord.commendations.map(c => (
                                                <li key={c.id} className="flex items-center gap-2 text-sm text-slate-300">
                                                    <i className="fa-solid fa-medal text-amber-400"></i> {c.name}
                                                </li>
                                            ))}
                                        </ul>
                                    ) : <p className="text-sm text-slate-500 italic">None.</p>}
                                </div>
                            </div>

                            {/* External Intel / Warrants */}
                            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                <h3 className="text-lg font-bold text-white mb-4">Intelligence & Cautions</h3>
                                {dossier ? (
                                    <div className="space-y-4">
                                        {dossier.warrants.filter(w => w.status === WarrantStatus.Active || w.status === WarrantStatus.Standing).length > 0 ? (
                                            <div className="bg-red-900/20 border-l-4 border-red-500 p-4 rounded-r">
                                                <div className="flex items-center gap-2 text-red-400 font-bold mb-1">
                                                    <i className="fa-solid fa-triangle-exclamation"></i>
                                                    <span>Active Caution Found</span>
                                                </div>
                                                <p className="text-sm text-red-200/80">Target has active cautions in the system.</p>
                                            </div>
                                        ) : (
                                            <div className="bg-green-900/10 border-l-4 border-green-500 p-4 rounded-r">
                                                <div className="flex items-center gap-2 text-green-400 font-bold mb-1">
                                                    <i className="fa-solid fa-check-circle"></i>
                                                    <span>No Active Cautions</span>
                                                </div>
                                            </div>
                                        )}

                                        {dossier.reports.length > 0 ? (
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                {dossier.reports.map(r => (
                                                    <div key={r.id} className="h-40" onClick={() => openWindow('request', r)}>
                                                        <IntelligenceReportCard report={r} onClick={() => { }} onViewDossier={() => { }} />
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            <p className="text-sm text-slate-500 italic text-center">No intelligence reports filed.</p>
                                        )}
                                    </div>
                                ) : (
                                    <p className="text-sm text-slate-500">Loading dossier...</p>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'interviews' && (
                        <div className="max-w-4xl space-y-6">
                            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                <div className="flex justify-between items-center mb-4">
                                    <h3 className="text-lg font-bold text-white">Interview Records</h3>
                                    {!isCompleted && (
                                        <button
                                            onClick={() => openScheduleInterviewModal(caseFile)}
                                            className="flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 rounded-lg shadow-lg shadow-emerald-900/30 transition"
                                        >
                                            <i className="fa-solid fa-plus mr-2"></i> Schedule
                                        </button>
                                    )}
                                </div>
                                {caseFile.interviews.length > 0 ? (
                                    <div className="space-y-3">
                                        {caseFile.interviews.map(int => (
                                            <div key={int.id} className="flex flex-col sm:flex-row justify-between items-start sm:items-center p-3 bg-slate-900/50 rounded-sm border border-slate-700 gap-3">
                                                <div>
                                                    <p className="text-white font-bold text-sm">{int.template.name}</p>
                                                    <div className="flex items-center gap-2 mt-0.5">
                                                        <p className="text-xs text-slate-500">Lead: {int.interviewer.name}</p>
                                                        {int.panelMembers?.length > 0 && (
                                                            <span className="text-[10px] text-indigo-400 font-semibold">+{int.panelMembers.length} panel</span>
                                                        )}
                                                    </div>
                                                    <p className="text-[10px] text-slate-500 mt-0.5 font-mono">{fmt(int.scheduledAt)}</p>
                                                </div>
                                                <div className="flex gap-2">
                                                    {int.status !== 'Completed' && !isCompleted && (
                                                        <button
                                                            onClick={() => openEditInterviewModal(int)}
                                                            className="text-xs px-3 py-1.5 rounded-sm border transition-colors uppercase font-bold bg-amber-600/20 text-amber-400 border-amber-600/30 hover:bg-amber-600 hover:text-white"
                                                        >
                                                            Edit
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => openConductInterviewModal(int)}
                                                        className={`text-[10px] px-3 py-1.5 rounded-lg border transition-colors uppercase font-black tracking-widest ${int.status === 'Completed' ? 'bg-green-500/10 text-green-300 border-green-500/30 hover:bg-green-500/20' : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20'}`}
                                                    >
                                                        {int.status === 'Completed' ? 'View Report' : 'Conduct Interview'}
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="text-sm text-slate-500 italic text-center py-6">No interviews scheduled.</p>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'log' && (
                        <div className="max-w-4xl space-y-4">
                            <h3 className="text-xl font-bold text-white mb-4">Activity Log</h3>
                            {localLogs.map(log => (
                                <div key={log.id} className="flex gap-3 text-sm relative group">
                                    <div className="shrink-0 w-32 md:w-36 text-right text-slate-500 font-mono text-[10px] md:text-xs pt-1">
                                        {fmt(log.createdAt)}
                                    </div>
                                    <div className="w-px bg-slate-700 relative shrink-0">
                                        <div className={`absolute top-1.5 -left-1 w-2 h-2 rounded-full ${log.actionType === 'STATUS_CHANGE' ? 'bg-amber-500' : 'bg-slate-600'}`}></div>
                                    </div>
                                    <div className="flex-1 pb-4 min-w-0">
                                        <p className="text-slate-300 wrap-break-word">{log.message}</p>
                                        <p className="text-xs text-slate-500 mt-1">by {log.user?.name || 'System'}</p>
                                    </div>
                                </div>
                            ))}
                            {localLogs.length === 0 && <p className="text-slate-500 italic text-sm">No activity logged.</p>}
                        </div>
                    )}

                    {activeTab === 'adjudication' && (
                        <div className="max-w-4xl space-y-6">

                            {/* VETTING: Clearance & Marker Assignment */}
                            {caseConfig.type === 'VETTING' && linkedMember && (
                                <div className="bg-indigo-900/10 border border-indigo-500/20 rounded-xl p-6">
                                    <h4 className="text-sm font-bold text-indigo-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                                        <i className="fa-solid fa-shield-halved"></i> Clearance Assignment
                                    </h4>
                                    <div className="flex items-center gap-4 mb-5 bg-slate-900/50 rounded-lg p-4 border border-slate-700/50">
                                        <div className="text-center flex-1">
                                            <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Current</p>
                                            <p className="text-white font-bold">{linkedMember.clearanceLevel?.name || 'None'}</p>
                                            {linkedMember.limitingMarkers && linkedMember.limitingMarkers.length > 0 && (
                                                <div className="flex flex-wrap justify-center gap-1 mt-1.5">
                                                    {linkedMember.limitingMarkers.map(m => (
                                                        <span key={m.id} className="text-[9px] font-mono font-bold bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded-sm">{m.code}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                        <i className="fa-solid fa-arrow-right text-indigo-500"></i>
                                        <div className="text-center flex-1">
                                            <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Applying</p>
                                            <p className="text-indigo-400 font-bold">{securityClearances.find(c => c.id.toString() === selectedLevelId)?.name || 'None'}</p>
                                            {selectedMarkers.size > 0 && (
                                                <div className="flex flex-wrap justify-center gap-1 mt-1.5">
                                                    {Array.from(selectedMarkers).map(id => {
                                                        const m = limitingMarkers.find(lm => lm.id === id);
                                                        return m ? <span key={id} className="text-[9px] font-mono font-bold bg-amber-900/30 text-amber-400 px-1.5 py-0.5 rounded-sm">{m.code}</span> : null;
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                    {!isCompleted && (
                                        <>
                                            <div className="mb-4">
                                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Clearance Level</label>
                                                <select value={selectedLevelId} onChange={(e) => setSelectedLevelId(e.target.value)} className={inputClass}>
                                                    <option value="">No Clearance</option>
                                                    {securityClearances.map(c => <option key={c.id} value={c.id}>{c.name} (Level {c.level})</option>)}
                                                </select>
                                            </div>
                                            {limitingMarkers.length > 0 && (
                                                <div>
                                                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Limiting Markers</label>
                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                        {limitingMarkers.map(m => (
                                                            <label key={m.id} className={`flex items-center gap-2 text-sm bg-slate-900/50 p-2.5 rounded-sm border cursor-pointer transition-colors ${selectedMarkers.has(m.id) ? 'border-amber-500/50 bg-amber-900/10' : 'border-slate-700/50 hover:bg-slate-800'}`}>
                                                                <input type="checkbox" checked={selectedMarkers.has(m.id)} onChange={() => toggleMarker(m.id)} className="accent-amber-500" />
                                                                <span className="font-mono text-xs text-amber-400 font-bold">{m.code}</span>
                                                                <span className="text-slate-400 text-xs truncate">{m.name}</span>
                                                            </label>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </>
                                    )}
                                    <p className="text-[10px] text-indigo-400/60 mt-3">
                                        <i className="fa-solid fa-circle-info mr-1"></i> Approving will update this member's security clearance and limiting markers.
                                    </p>
                                </div>
                            )}

                            {/* TRANSFER: Unit Transfer Details */}
                            {caseConfig.type === 'TRANSFER' && (
                                <div className="bg-amber-900/10 border border-amber-500/20 rounded-xl p-6">
                                    <h4 className="text-sm font-bold text-amber-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                                        <i className="fa-solid fa-right-left"></i> Transfer Action
                                    </h4>
                                    {transferRequest ? (
                                        <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700/50">
                                            <div className="flex items-center gap-4 text-sm">
                                                <div className="text-center flex-1">
                                                    <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">From</p>
                                                    <p className="text-white font-bold">{linkedMember?.unit?.name || 'Unassigned'}</p>
                                                </div>
                                                <i className="fa-solid fa-arrow-right text-amber-500"></i>
                                                <div className="text-center flex-1">
                                                    <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">To</p>
                                                    <p className="text-amber-400 font-bold">{(transferRequest as any).targetUnit?.name || 'Unknown'}</p>
                                                </div>
                                            </div>
                                            {transferRequest.reason && (
                                                <p className="text-xs text-slate-400 mt-3 italic border-t border-slate-700/50 pt-3">"{transferRequest.reason}"</p>
                                            )}
                                        </div>
                                    ) : (
                                        <p className="text-sm text-slate-500 italic">No linked transfer request found. The member's unit will not be changed.</p>
                                    )}
                                    <p className="text-[10px] text-amber-400/60 mt-3">
                                        <i className="fa-solid fa-circle-info mr-1"></i> Approving will move this member to the target unit.
                                    </p>
                                </div>
                            )}

                            {/* JOB: Position Assignment */}
                            {caseConfig.type === 'JOB' && (
                                <div className="bg-blue-900/10 border border-blue-500/20 rounded-xl p-6">
                                    <h4 className="text-sm font-bold text-blue-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                                        <i className="fa-solid fa-briefcase"></i> Position Assignment
                                    </h4>
                                    <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700/50">
                                        <div className="flex items-center gap-4 text-sm">
                                            <div className="text-center flex-1">
                                                <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Current Position</p>
                                                <p className="text-white font-bold" title={linkedMember?.position?.description || undefined}>{linkedMember?.position?.name || 'None'}</p>
                                                {linkedMember?.position?.description && (
                                                    <p className="text-[10px] text-slate-400 mt-1 line-clamp-2">{linkedMember.position.description}</p>
                                                )}
                                            </div>
                                            <i className="fa-solid fa-arrow-right text-blue-500"></i>
                                            <div className="text-center flex-1">
                                                <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">New Position</p>
                                                <p className="text-blue-400 font-bold">{linkedJob?.job?.position?.name || linkedJob?.title || 'Pending'}</p>
                                            </div>
                                        </div>
                                    </div>
                                    <p className="text-[10px] text-blue-400/60 mt-3">
                                        <i className="fa-solid fa-circle-info mr-1"></i> Approving will assign this member to the linked personnel position.
                                    </p>
                                </div>
                            )}

                            {/* RECRUITMENT (Website Application): Membership Promotion */}
                            {caseConfig.type === 'RECRUITMENT' && caseFile.referralSource === 'WEBSITE_APPLICATION' && (
                                <div className="bg-emerald-500/5 border border-emerald-500/30 rounded-xl p-6">
                                    <h4 className="text-sm font-bold text-emerald-300 uppercase tracking-wider mb-4 flex items-center gap-2">
                                        <i className="fa-solid fa-user-plus"></i> Membership Promotion
                                    </h4>
                                    <div className="bg-slate-900/50 rounded-lg p-4 border border-slate-700/50">
                                        <div className="flex items-center gap-4 text-sm">
                                            <div className="text-center flex-1">
                                                <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">Current Role</p>
                                                <p className="text-white font-bold">{linkedMember?.role || 'Client'}</p>
                                            </div>
                                            <i className="fa-solid fa-arrow-right text-emerald-300"></i>
                                            <div className="text-center flex-1">
                                                <p className="text-[10px] text-slate-500 uppercase font-bold tracking-wider mb-1">New Role</p>
                                                <p className="text-emerald-300 font-bold">Member</p>
                                            </div>
                                        </div>
                                    </div>
                                    <p className="text-[10px] text-emerald-300/70 mt-3">
                                        <i className="fa-solid fa-circle-info mr-1"></i> Approving will promote this applicant to full Member status (subject to member cap).
                                    </p>
                                    {hrConfig.probationDays && hrConfig.probationDays > 0 && (
                                        <div className="mt-4 bg-amber-900/10 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2.5">
                                            <i className="fa-solid fa-hourglass-half text-amber-400 mt-0.5"></i>
                                            <div>
                                                <p className="text-xs font-bold text-amber-400">Probation Period: {hrConfig.probationDays} days</p>
                                                <p className="text-[10px] text-amber-400/60 mt-0.5">This member will be placed on probation automatically upon hiring.</p>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* RECRUITMENT: New Hire Assignment */}
                            {caseConfig.type === 'RECRUITMENT' && !isCompleted && (
                                <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                    <h4 className="text-sm font-bold text-slate-300 uppercase tracking-wider mb-4 flex items-center gap-2">
                                        <i className="fa-solid fa-user-gear text-slate-500"></i> New Hire Assignment
                                        <span className="text-[10px] font-normal normal-case text-slate-500 ml-1">(Optional)</span>
                                    </h4>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div>
                                            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Unit</label>
                                            <select value={hireUnitId} onChange={(e) => setHireUnitId(e.target.value)} className={inputClass}>
                                                <option value="">No Assignment</option>
                                                {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Rank</label>
                                            <select value={hireRankId} onChange={(e) => setHireRankId(e.target.value)} className={inputClass}>
                                                <option value="">No Assignment</option>
                                                {ranks.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Clearance Level</label>
                                            <select value={hireClearanceLevelId} onChange={(e) => setHireClearanceLevelId(e.target.value)} className={inputClass}>
                                                <option value="">No Clearance</option>
                                                {securityClearances.map(c => <option key={c.id} value={c.id}>{c.name} (Level {c.level})</option>)}
                                            </select>
                                        </div>
                                        {limitingMarkers.length > 0 && (
                                            <div>
                                                <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5">Limiting Markers</label>
                                                <div className="space-y-1.5">
                                                    {limitingMarkers.map(m => (
                                                        <label key={m.id} className={`flex items-center gap-2 text-sm bg-slate-900/50 p-2 rounded-sm border cursor-pointer transition-colors ${hireClearanceMarkers.has(m.id) ? 'border-amber-500/50 bg-amber-900/10' : 'border-slate-700/50 hover:bg-slate-800'}`}>
                                                            <input type="checkbox" checked={hireClearanceMarkers.has(m.id)} onChange={() => setHireClearanceMarkers(prev => { const next = new Set(prev); next.has(m.id) ? next.delete(m.id) : next.add(m.id); return next; })} className="accent-amber-500" />
                                                            <span className="font-mono text-xs text-amber-400 font-bold">{m.code}</span>
                                                            <span className="text-slate-400 text-xs truncate">{m.name}</span>
                                                        </label>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                    <p className="text-[10px] text-slate-500 mt-3">
                                        <i className="fa-solid fa-circle-info mr-1"></i> These assignments will be applied when the hire is approved. Leave blank to skip.
                                    </p>
                                </div>
                            )}

                            {/* Probation notice for non-website recruitment & job hires */}
                            {(caseConfig.type === 'RECRUITMENT' && caseFile.referralSource !== 'WEBSITE_APPLICATION' || caseConfig.type === 'JOB') && hrConfig.probationDays && hrConfig.probationDays > 0 && (
                                caseFile.linkedUserId ? (
                                    <div className="bg-amber-900/10 border border-amber-500/20 rounded-xl p-4 flex items-start gap-2.5">
                                        <i className="fa-solid fa-hourglass-half text-amber-400 mt-0.5"></i>
                                        <div>
                                            <p className="text-xs font-bold text-amber-400">Probation Period: {hrConfig.probationDays} days</p>
                                            <p className="text-[10px] text-amber-400/60 mt-0.5">This member will be placed on probation automatically upon hiring.</p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="bg-slate-800/50 border border-slate-600/40 rounded-xl p-4 flex items-start gap-2.5">
                                        <i className="fa-solid fa-circle-info text-slate-400 mt-0.5"></i>
                                        <div>
                                            <p className="text-xs font-bold text-slate-300">Probation cannot be applied automatically</p>
                                            <p className="text-[10px] text-slate-400 mt-0.5">This candidate has no linked account yet — they need to log in via Discord first. After hiring, set probation manually from their profile once they appear in the roster.</p>
                                        </div>
                                    </div>
                                )
                            )}

                            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                <h3 className="text-lg font-bold text-white mb-4">Final Determination</h3>

                                <div className="mb-6">
                                    <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Decision Rationale / Closing Note</label>
                                    <textarea
                                        value={finalNotes}
                                        onChange={(e) => setFinalNotes(e.target.value)}
                                        rows={4}
                                        className="w-full bg-slate-900 border border-slate-700 rounded-lg p-4 text-white text-sm focus:border-amber-500 outline-hidden resize-none"
                                        placeholder="Provide justification for the final decision..."
                                        disabled={isCompleted}
                                    />
                                </div>

                                {!isCompleted && (
                                    <div className="flex gap-4 border-t border-slate-700 pt-6">
                                        <button
                                            onClick={() => handleDecision('Approve')}
                                            disabled={isSaving || caseFile.status === ApplicationStatus.Hired}
                                            className="flex-1 bg-green-600 hover:bg-green-500 text-white font-bold py-4 px-6 rounded-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2"
                                        >
                                            {isSaving ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-check"></i>} {caseConfig.type === 'RECRUITMENT' || caseConfig.type === 'JOB' ? 'Hire Candidate' : 'Approve Request'}
                                        </button>
                                        <button
                                            onClick={() => handleDecision('Deny')}
                                            disabled={isSaving || caseFile.status === ApplicationStatus.Rejected}
                                            className="flex-1 bg-red-600 hover:bg-red-500 text-white font-bold py-4 px-6 rounded-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-widest transition-all active:scale-95 flex items-center justify-center gap-2"
                                        >
                                            {isSaving ? <i className="fa-solid fa-spinner animate-spin"></i> : <i className="fa-solid fa-xmark"></i>} {caseConfig.type === 'RECRUITMENT' || caseConfig.type === 'JOB' ? 'Reject Candidate' : 'Deny Request'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'admin' && canManage && (
                        <div className="max-w-xl space-y-6">
                            {/* Reset Status Section */}
                            <div className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6">
                                <h3 className="text-lg font-bold text-white mb-2">Case Status Override</h3>
                                <p className="text-sm text-slate-400 mb-4">Manually change the status of this case file. Use this to reopen closed cases.</p>
                                <div className="flex gap-2">
                                    <select
                                        value={resetStatus}
                                        onChange={(e) => setResetStatus(e.target.value as ApplicationStatus)}
                                        className="flex-1 bg-slate-900 border border-slate-700 rounded-sm p-2 text-white text-sm"
                                    >
                                        <option value="">- Select Target Status -</option>
                                        {Object.values(ApplicationStatus).map(s => <option key={s} value={s}>{s}</option>)}
                                    </select>
                                    <button
                                        onClick={handleResetStatus}
                                        disabled={isSaving || !resetStatus}
                                        className="flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 rounded-lg shadow-lg shadow-emerald-900/30 transition disabled:opacity-50"
                                    >
                                        Update Status
                                    </button>
                                </div>
                            </div>

                            <div className="bg-red-900/10 border border-red-500/30 rounded-xl p-6">
                                <h3 className="text-lg font-bold text-red-400 mb-2">Danger Zone</h3>
                                <p className="text-sm text-slate-400 mb-6">Permanently remove this case file and all associated records from the database.</p>
                                <button
                                    onClick={handleDelete}
                                    className="bg-red-600 hover:bg-red-500 text-white font-bold py-2 px-6 rounded-sm shadow-lg shadow-red-900/20 transition-colors uppercase text-sm disabled:opacity-50 disabled:cursor-wait"
                                    disabled={isSaving || isDeleting}
                                >
                                    {isDeleting ? <><i className="fa-solid fa-spinner animate-spin mr-2"></i>Deleting...</> : 'Delete Case File'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default UnifiedCaseFileView;
