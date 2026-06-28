
import React, { useState, useEffect, useMemo } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';

import { HydratedHRApplication, ApplicationStatus, VettingData, VettingChecklist, DossierData, formatReferralSource } from '../../../types';
import IntelligenceReportCard from '../../views/intel/IntelligenceReportCard';
import WindowFrame from '../../layout/WindowFrame';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

interface SecurityVettingModalProps {
    isOpen: boolean;
    onClose: () => void;
    applicant: HydratedHRApplication;
}

const defaultChecklist: VettingChecklist = {
    rsiProfile: 'pending',
    orgHistory: 'pending',
    internalRecord: 'pending',
    interview: 'pending'
};

const StatusDot: React.FC<{ status: string }> = ({ status }) => {
    let color = 'bg-slate-600';
    if (status === 'clear') color = 'bg-green-500 shadow-green-500/50';
    if (status === 'flagged') color = 'bg-red-500 shadow-red-500/50';
    return <div className={`w-2 h-2 rounded-full ${color} shadow-[0_0_8px]`} />;
};

const getClearanceColor = (level: number) => {
    switch (level) {
        case 1: return 'text-green-400 border-green-500/30 bg-green-500/10';
        case 2: return 'text-sky-400 border-sky-500/30 bg-sky-500/10';
        case 3: return 'text-amber-400 border-amber-500/30 bg-amber-500/10';
        case 4: return 'text-orange-500 border-orange-500/30 bg-orange-500/10';
        case 5: return 'text-red-500 border-red-500/30 bg-red-500/10';
        default: return 'text-slate-400 border-slate-500/30 bg-slate-500/10';
    }
};

const SecurityVettingModal: React.FC<SecurityVettingModalProps> = ({ isOpen, onClose, applicant }) => {
    const { rpcAction, refreshHR, fetchUserDetail } = useData();
    const { securityClearances, limitingMarkers, allUsers, updateUserClearance } = useMembers();
    const { currentUser } = useAuth();
    const fmt = useFormatDate();
    const { openScheduleInterviewModal, openEditInterviewModal, openConductInterviewModal, openWindow, openCaseDetailsModal } = useModalRegistry();
    const [activeTab, setActiveTab] = useState<'overview' | 'background' | 'interview' | 'adjudication'>('overview');
    const [isLoading, setIsLoading] = useState(false);
    const [vettingLoading, setVettingLoading] = useState(true);

    const [vettingData, setVettingData] = useState<VettingData>({
        stage: 'investigation',
        checks: { ...defaultChecklist },
        comments: {}
    });

    const [dossier, setDossier] = useState<DossierData | null>(null);
    const [finalStatus, setFinalStatus] = useState<'Hired' | 'Rejected' | 'Revoked' | null>(null);
    const [finalNotes, setFinalNotes] = useState('');
    const [selectedLevelId, setSelectedLevelId] = useState<string>('');
    const [selectedMarkers, setSelectedMarkers] = useState<Set<number>>(() => new Set());

    const cachedLinkedMember = useMemo(() => allUsers.find(u => u.id === applicant.linkedUserId), [allUsers, applicant.linkedUserId]);
    // The roster cache trims `limitingMarkers` to keep main-subset egress small.
    // This modal needs them to seed `selectedMarkers` correctly — without the
    // lazy-fetch the markers would default to empty and a save would clear
    // the user's existing markers. Fetch the full record when the modal opens.
    const [fullLinkedMember, setFullLinkedMember] = useState<typeof cachedLinkedMember | null>(null);
    useEffect(() => {
        if (!isOpen || !applicant.linkedUserId) return;
        let cancelled = false;
        (async () => {
            const full = await fetchUserDetail(applicant.linkedUserId!);
            if (!cancelled && full) setFullLinkedMember(full as any);
        })();
        return () => { cancelled = true; };
    }, [isOpen, applicant.linkedUserId, fetchUserDetail]);
    const linkedMember = fullLinkedMember || cachedLinkedMember;

    const requestedLevel = useMemo(() => {
        if (!applicant.notes) return null;
        const match = applicant.notes.match(/Level (\d+)/i);
        if (match && match[1]) {
            const lvl = parseInt(match[1]);
            return securityClearances.find(c => c.level === lvl);
        }
        return null;
    }, [applicant.notes, securityClearances]);

    // Vetting data is lazy-loaded on open (no longer shipped in the bulk applicant
    // list — it's recruiter-grade PII rendered one applicant at a time). vettingLoading
    // guards the save handlers so a save fired before the fetch lands can't overwrite
    // the real vetting record with the empty default.
    //
    // Reset the editable, async-loaded vetting state when the selected applicant
    // changes or the modal (re)opens, clearing the previous applicant's
    // recruiter-grade PII before the new fetch lands. This runs during render
    // (React's "adjust state on a key change" pattern) rather than in an effect.
    // vettingLoading/vettingData already initialize to exactly these reset values,
    // so on first mount this is a no-op; it only does visible work on a later
    // applicant change / reopen, ahead of the async refetch in the effect below.
    const vettingResetKey = `${isOpen ? 1 : 0}:${applicant.id}`;
    const [prevVettingResetKey, setPrevVettingResetKey] = useState(vettingResetKey);
    if (vettingResetKey !== prevVettingResetKey) {
        setPrevVettingResetKey(vettingResetKey);
        if (isOpen) {
            setVettingLoading(true);
            setVettingData({ stage: 'investigation', checks: { ...defaultChecklist }, comments: {} });
        }
    }
    useEffect(() => {
        if (!isOpen) return;
        let cancelled = false;
        (async () => {
            try {
                const loaded = (await rpcAction('hr:get_application_data', { id: applicant.id })) as Partial<VettingData> | null;
                if (cancelled) return;
                const d = loaded || {};
                setVettingData({
                    stage: d.stage || 'investigation',
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
    }, [isOpen, applicant.id, rpcAction]);

    // Seed the editable clearance form fields from the (lazy-loaded) full linked
    // member, and reset the final-determination fields, when the modal opens, the
    // applicant changes, or that linked-member record arrives. These are
    // user-editable <select>/marker controls that feed updateUserClearance on
    // finalize, so they must be component state. This runs during render (React's
    // "adjust state on a key change" pattern) rather than in an effect, which
    // preserves the original timing: the seed re-runs on exactly the same input
    // changes the effect keyed on (isOpen/applicant/linkedMember). Getting the
    // markers right is security-relevant — a wrong seed could clear the user's
    // existing limiting markers on save (see fullLinkedMember note above).
    // seedTracker starts null so the block also runs on the initial render (mirroring
    // the effect firing on mount), guarded by isOpen exactly as before.
    const [seedTracker, setSeedTracker] = useState<{
        isOpen: boolean;
        applicant: HydratedHRApplication;
        linkedMember: typeof linkedMember;
    } | null>(null);
    if (
        !seedTracker
        || seedTracker.isOpen !== isOpen
        || seedTracker.applicant !== applicant
        || seedTracker.linkedMember !== linkedMember
    ) {
        setSeedTracker({ isOpen, applicant, linkedMember });
        if (isOpen) {
            if (linkedMember) {
                setSelectedLevelId(linkedMember.clearanceLevel?.id.toString() || '');
                setSelectedMarkers(new Set(linkedMember.limitingMarkers?.map(m => m.id)));
            }
            setFinalStatus(null);
            setFinalNotes('');
        }
    }

    // Dossier lookup is async I/O so it stays in an effect. It re-runs when the
    // modal opens or the applicant changes (the dossier is a function of
    // applicant.rsiHandle); dossier is intentionally not cleared between
    // applicants, matching the original (the prior dossier shows until the new
    // one lands).
    useEffect(() => {
        if (!isOpen) return;
        rpcAction('intel:get_dossier', { targetId: applicant.rsiHandle })
            .then(setDossier)
            .catch(console.error);
    }, [isOpen, applicant, rpcAction]);

    const handleSaveProgress = async () => {
        if (vettingLoading) return; // don't persist the empty default before the fetch lands
        setIsLoading(true);
        try {
            await rpcAction('hr:update_application_data', { id: applicant.id, data: vettingData });
            await refreshHR();
        } catch (error) { console.error(error); } finally { setIsLoading(false); }
    };

    const updateCheck = (key: keyof VettingChecklist, status: 'pending' | 'clear' | 'flagged') => {
        setVettingData(prev => ({ ...prev, checks: { ...prev.checks, [key]: status } }));
    };

    const updateComment = (key: string, value: string) => {
        setVettingData(prev => ({ ...prev, comments: { ...prev.comments, [key]: value } }));
    };

    const handleToggleMarker = (id: number) => {
        setSelectedMarkers(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleFinalize = async () => {
        if (vettingLoading || !finalStatus || !confirm("Finalize determination? This will update clearance.")) return;
        setIsLoading(true);
        try {
            let appStatus: ApplicationStatus = ApplicationStatus.Rejected;
            if (finalStatus === 'Hired') appStatus = ApplicationStatus.Hired;

            await rpcAction('hr:update_app_status', { id: applicant.id, status: appStatus, notes: finalNotes, userId: currentUser?.id });
            await rpcAction('hr:update_application_data', { id: applicant.id, data: { ...vettingData, stage: 'adjudication' } });

            if ((finalStatus === 'Hired' || finalStatus === 'Revoked') && linkedMember) {
                const levelId = selectedLevelId ? parseInt(selectedLevelId) : null;
                await updateUserClearance(linkedMember.id, levelId, Array.from(selectedMarkers));
            }
            await refreshHR();
            onClose();
        } catch (err) { console.error(err); } finally { setIsLoading(false); }
    };

    const inputClass ="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/50 outline-hidden transition-all resize-none";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Security Vetting Console"
            subtitle={`${applicant.applicantName} // ${applicant.rsiHandle}`}
            icon="fa-solid fa-shield-halved"
            color="emerald"
            width="max-w-6xl"
        >
            <div className="flex flex-col md:flex-row h-[75vh]">
                {/* Sidebar */}
                <div className="w-56 bg-slate-900/50 border-r border-slate-700/50 flex flex-col shrink-0">
                    <div className="p-3 space-y-1">
                        {[
                            { id: 'overview', label: 'Overview', icon: 'fa-file-lines' },
                            { id: 'background', label: 'Investigation', icon: 'fa-magnifying-glass' },
                            { id: 'interview', label: 'Interviews', icon: 'fa-microphone-lines' },
                            { id: 'adjudication', label: 'Adjudication', icon: 'fa-gavel' }
                        ].map(tab => (
                            <button
                                key={tab.id}
                                onClick={() => setActiveTab(tab.id as any)}
                                className={`w-full text-left px-3 py-2.5 rounded-lg text-xs font-bold uppercase tracking-wide flex items-center gap-3 transition-colors ${activeTab === tab.id ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/30' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200 border border-transparent'}`}
                            >
                                <i className={`fa-solid ${tab.icon} w-4 text-center`}></i> {tab.label}
                            </button>
                        ))}
                    </div>
                    <div className="mt-auto p-4 border-t border-slate-800/50">
                        <div className="bg-slate-950/50 p-3 rounded-sm border border-slate-800 text-[10px] text-slate-400 space-y-2 uppercase font-bold tracking-wider">
                            <div className="flex justify-between items-center"><span>RSI Check</span><StatusDot status={vettingData.checks.rsiProfile} /></div>
                            <div className="flex justify-between items-center"><span>Org History</span><StatusDot status={vettingData.checks.orgHistory} /></div>
                            <div className="flex justify-between items-center"><span>Interview</span><StatusDot status={vettingData.checks.interview} /></div>
                        </div>
                    </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-6 bg-slate-900/30 relative">
                    <div className="absolute top-4 right-6 z-10">
                        <button onClick={handleSaveProgress} disabled={isLoading || vettingLoading} className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded-sm border border-slate-700 font-bold uppercase transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {(isLoading || vettingLoading) ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-floppy-disk mr-2"></i> Save Progress</>}
                        </button>
                    </div>

                    {activeTab === 'overview' && (
                        <div className="max-w-3xl space-y-6">
                            <div className="bg-slate-950/30 border border-slate-700/50 rounded-xl p-6">
                                <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest mb-4">Request Data</h3>
                                <div className="grid grid-cols-2 gap-4 text-sm">
                                    <div><span className="text-slate-500 block text-[10px] uppercase font-bold">Source</span><span className="text-white">{formatReferralSource(applicant.referralSource)}</span></div>
                                    <div><span className="text-slate-500 block text-[10px] uppercase font-bold">Filed</span><span className="text-white font-mono">{fmt.date(applicant.createdAt)}</span></div>
                                </div>
                                <div className="mt-4 bg-slate-900/50 p-4 rounded-sm border border-slate-800 text-slate-300 text-sm whitespace-pre-wrap font-mono">{applicant.notes || "No notes."}</div>
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                {linkedMember && (
                                    <div className="bg-slate-950/30 border border-slate-700/50 rounded-xl p-4">
                                        <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Current</h3>
                                        <div className={`inline-block px-3 py-1 rounded-sm border text-xs font-bold uppercase ${getClearanceColor(linkedMember.clearanceLevel?.level || 0)}`}>
                                            {linkedMember.clearanceLevel?.name || 'None'}
                                        </div>
                                    </div>
                                )}
                                {requestedLevel && (
                                    <div className="bg-slate-950/30 border border-slate-700/50 rounded-xl p-4">
                                        <h3 className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-2">Requested</h3>
                                        <div className={`inline-block px-3 py-1 rounded-sm border text-xs font-bold uppercase ${getClearanceColor(requestedLevel.level)}`}>
                                            {requestedLevel.name}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeTab === 'background' && (
                        <div className="max-w-4xl space-y-6">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                {[
                                    { key: 'rsiProfile', label: 'RSI Profile' },
                                    { key: 'orgHistory', label: 'Org History' },
                                    { key: 'internalRecord', label: 'Conduct' }
                                ].map((item) => (
                                    <div key={item.key} className="bg-slate-950/30 border border-slate-700/50 rounded-lg p-4 flex flex-col">
                                        <div className="flex justify-between items-center mb-3">
                                            <h3 className="text-xs font-bold text-slate-300 uppercase">{item.label}</h3>
                                            <div className="flex gap-1">
                                                {['clear', 'flagged', 'pending'].map(status => (
                                                    <button key={status} onClick={() => updateCheck(item.key as any, status as any)} className={`w-2 h-2 rounded-full transition-all ${vettingData.checks[item.key as keyof VettingChecklist] === status ? (status === 'clear' ? 'bg-green-500 ring-2 ring-green-500/30' : status === 'flagged' ? 'bg-red-500 ring-2 ring-red-500/30' : 'bg-slate-500') : 'bg-slate-800'}`} title={status} />
                                                ))}
                                            </div>
                                        </div>
                                        <textarea
                                            value={vettingData.comments[item.key] || ''}
                                            onChange={(e) => updateComment(item.key, e.target.value)}
                                            className={`${inputClass} flex-1 text-xs h-24`}
                                            placeholder="Notes..."
                                        />
                                    </div>
                                ))}
                            </div>

                            {/* Intel & Warrants */}
                            <div className="bg-slate-950/30 border border-slate-700/50 rounded-xl p-6">
                                <h3 className="text-xs font-black text-slate-500 uppercase tracking-widest mb-4">Intel Database</h3>
                                {dossier ? (
                                    <div className="space-y-3">
                                        {dossier.warrants.some(w => w.status === 'Active') && (
                                            <div className="bg-red-500/10 border border-red-500/30 text-red-400 px-4 py-2 rounded-sm text-xs font-bold uppercase tracking-wide flex items-center gap-2">
                                                <i className="fa-solid fa-triangle-exclamation"></i> Active Caution Found
                                            </div>
                                        )}
                                        {dossier.reports.length > 0 ? (
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                {dossier.reports.map(r => (
                                                    <div key={r.id} className="h-32" onClick={() => openWindow('request', r)}>
                                                        <IntelligenceReportCard report={r} onClick={() => { }} onViewDossier={() => { }} />
                                                    </div>
                                                ))}
                                            </div>
                                        ) : <p className="text-xs text-slate-500 italic">No reports found.</p>}
                                    </div>
                                ) : <p className="text-xs text-slate-500 animate-pulse">Scanning database...</p>}
                            </div>
                        </div>
                    )}

                    {activeTab === 'interview' && (
                        <div className="max-w-3xl space-y-4">
                            <div className="flex justify-between items-center">
                                <h3 className="text-sm font-bold text-white uppercase tracking-wider">Interviews</h3>
                                <button onClick={() => openScheduleInterviewModal(applicant)} className="bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20 px-3 py-1.5 rounded-sm text-[10px] font-bold uppercase transition-colors">
                                    <i className="fa-solid fa-plus mr-1"></i> Schedule
                                </button>
                            </div>
                            {applicant.interviews.map(int => (
                                <div key={int.id} className="bg-slate-950/30 border border-slate-700/50 rounded-lg p-3 flex justify-between items-center">
                                    <div>
                                        <p className="text-slate-300 text-sm font-bold">{int.template.name}</p>
                                        <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                                            {int.status.toUpperCase()} • {int.interviewer.name}
                                            {int.panelMembers?.length > 0 && (
                                                <span className="text-emerald-300 font-semibold"> +{int.panelMembers.length} panel</span>
                                            )}
                                        </p>
                                    </div>
                                    <div className="flex gap-2">
                                        {int.status !== 'Completed' && (
                                            <button onClick={() => openEditInterviewModal(int)} className="text-[10px] bg-amber-600/10 hover:bg-amber-600 text-amber-400 hover:text-white px-3 py-1.5 rounded-sm border border-amber-600/30 uppercase font-bold transition-colors">
                                                Edit
                                            </button>
                                        )}
                                        <button onClick={() => openConductInterviewModal(int)} className="text-[10px] bg-slate-800 hover:bg-slate-700 text-white px-3 py-1.5 rounded-sm border border-slate-700 uppercase font-bold transition-colors">
                                            {int.status === 'Completed' ? 'View' : 'Start'}
                                        </button>
                                    </div>
                                </div>
                            ))}
                            {applicant.interviews.length === 0 && <p className="text-xs text-slate-500 italic border-2 border-dashed border-slate-800 rounded-sm p-4 text-center">No interviews scheduled.</p>}

                            <div className="mt-6 pt-6 border-t border-slate-800/50">
                                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Interview Finding</h3>
                                <div className="flex gap-2 mb-2">
                                    {['clear', 'flagged', 'pending'].map(s => (
                                        <button key={s} onClick={() => updateCheck('interview', s as any)} className={`flex-1 py-1 rounded-sm text-[10px] font-bold uppercase border transition-colors ${vettingData.checks.interview === s ? (s === 'clear' ? 'bg-green-500/20 text-green-400 border-green-500/40' : s === 'flagged' ? 'bg-red-500/20 text-red-400 border-red-500/40' : 'bg-slate-700 text-white border-slate-600') : 'bg-slate-900 border-slate-800 text-slate-500'}`}>{s}</button>
                                    ))}
                                </div>
                                <textarea
                                    value={vettingData.comments['interview'] || ''}
                                    onChange={(e) => updateComment('interview', e.target.value)}
                                    className={`${inputClass} h-32`}
                                    placeholder="Summary of findings..."
                                />
                            </div>
                        </div>
                    )}

                    {activeTab === 'adjudication' && (
                        <div className="max-w-3xl space-y-6">
                            <div className="bg-slate-950/30 border border-slate-700/50 rounded-xl p-6">
                                <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-4">Final Determination</h3>
                                <div className="flex gap-3 mb-6">
                                    <button onClick={() => setFinalStatus('Hired')} className={`flex-1 py-4 rounded-lg border-2 flex flex-col items-center justify-center gap-2 transition-all ${finalStatus === 'Hired' ? 'bg-green-500/10 border-green-500 text-green-400 shadow-[0_0_20px_rgba(34,197,94,0.1)]' : 'bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700'}`}>
                                        <i className="fa-solid fa-check-circle text-2xl"></i>
                                        <span className="text-xs font-black uppercase">Approve</span>
                                    </button>
                                    <button onClick={() => setFinalStatus('Rejected')} className={`flex-1 py-4 rounded-lg border-2 flex flex-col items-center justify-center gap-2 transition-all ${finalStatus === 'Rejected' ? 'bg-red-500/10 border-red-500 text-red-400 shadow-[0_0_20px_rgba(220,38,38,0.1)]' : 'bg-slate-900 border-slate-800 text-slate-500 hover:border-slate-700'}`}>
                                        <i className="fa-solid fa-ban text-2xl"></i>
                                        <span className="text-xs font-black uppercase">Reject</span>
                                    </button>
                                </div>

                                {(finalStatus === 'Hired' || finalStatus === 'Revoked') && (
                                    <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700 mb-6 animate-fade-in">
                                        <label className="block text-[10px] font-bold text-slate-500 uppercase mb-2">Set Clearance Level</label>
                                        <select value={selectedLevelId} onChange={(e) => setSelectedLevelId(e.target.value)} className={inputClass}>
                                            <option value="">No Clearance</option>
                                            {securityClearances.map(c => <option key={c.id} value={c.id}>Level {c.level} - {c.name}</option>)}
                                        </select>
                                    </div>
                                )}

                                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-2">Decision Notes</label>
                                <textarea
                                    value={finalNotes}
                                    onChange={(e) => setFinalNotes(e.target.value)}
                                    rows={4}
                                    className={inputClass}
                                    placeholder="Justification..."
                                />

                                <div className="flex justify-end mt-6">
                                    <button
                                        onClick={handleFinalize}
                                        disabled={isLoading || vettingLoading || !finalStatus}
                                        className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 border border-emerald-500/40 rounded-lg shadow-lg shadow-emerald-900/30 transition disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Submit & Close File'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </WindowFrame>
    );
};

export default SecurityVettingModal;
