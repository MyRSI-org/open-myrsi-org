
import React, { useState, useCallback, useMemo } from 'react';
import { ServiceType, UrgencyLevel, ThreatLevel, HydratedServiceRequest, ServiceRequestStatus } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useRequests } from '../../contexts/RequestsContext';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';
import { useConfig } from '../../contexts/ConfigContext';

import LocationInput from '../ui/LocationInput';
import WindowFrame from '../layout/WindowFrame';
import { useNavigation } from '../../contexts/NavigationContext';
import { mayRaiseRequest } from '../../lib/requestLifecycle';

interface CreateRequestModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const CreateRequestModal: React.FC<CreateRequestModalProps> = ({ isOpen, onClose }) => {
    const { currentUser } = useAuth();
    const { createRequest } = useRequests();
    const { refreshRequests, refreshMainState, hydratedServiceRequests } = useData();
    const { anyStaffOnDuty } = useMembers();
    const { brandingConfig, heroCardConfig, serviceTypes } = useConfig();
    const { viewRequestDetails } = useNavigation();

    React.useEffect(() => {
        if (isOpen) {
            refreshMainState();
            refreshRequests();
        }
    }, [isOpen, refreshMainState, refreshRequests]);

    // Default to the first available active service type or fall back to empty string (which will require selection)
    const activeServiceTypes = useMemo(() => serviceTypes.filter(t => t.isActive), [serviceTypes]);
    const [serviceType, setServiceType] = useState<ServiceType>(activeServiceTypes.length > 0 ? activeServiceTypes[0].name : 'Security');

    const [location, setLocation] = useState('');
    const [description, setDescription] = useState('');
    const [threatLevel, setThreatLevel] = useState<ThreatLevel>(ThreatLevel.None);
    const [urgency, setUrgency] = useState<UrgencyLevel>(UrgencyLevel.Medium);
    const [partyInfo, setPartyInfo] = useState('');
    const [partyHandles, setPartyHandles] = useState<string[]>([]);
    const [currentHandle, setCurrentHandle] = useState('');
    const [tosAgreed, setTosAgreed] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [submissionError, setSubmissionError] = useState<string | null>(null);

    const isClient = currentUser?.role === 'Client';

    const clientHasActiveRequest = useMemo(() => {
        if (!currentUser || currentUser.role !== 'Client') return false;
        return hydratedServiceRequests.some(r =>
            r.clientId === currentUser.id &&
            [
                ServiceRequestStatus.Submitted,
                ServiceRequestStatus.Triaged,
                ServiceRequestStatus.Accepted,
                ServiceRequestStatus.InProgress
            ].includes(r.status)
        );
    }, [currentUser, hydratedServiceRequests]);

    const handleAddHandle = (e: React.MouseEvent | React.KeyboardEvent) => {
        e.preventDefault();
        const trimmed = currentHandle.trim();
        if (trimmed && !partyHandles.includes(trimmed)) {
            setPartyHandles([...partyHandles, trimmed]);
            setCurrentHandle('');
        }
    };

    const handleRemoveHandle = (handle: string) => {
        setPartyHandles(partyHandles.filter(h => h !== handle));
    };

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!currentUser) return;

        if (description.trim() && location.trim()) {
            setIsLoading(true);
            try {
                const newId = await createRequest({
                    serviceType, location, description, urgency,
                    threatLevel, partyInfo: partyInfo.trim() || undefined,
                    secondaryClientHandles: partyHandles
                });

                await refreshRequests();

                // Optimistic UI
                const dummyReq: HydratedServiceRequest = {
                    id: newId, serviceType, location, description, status: ServiceRequestStatus.Submitted,
                    urgency, threatLevel, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                    client: currentUser, clientId: currentUser.id, assignedMembers: [], assignedMemberIds: [],
                    secondaryClientHandles: partyHandles, statusHistory: [], hydratedStatusHistory: [],
                    partyInfo: partyInfo.trim() || undefined,
                    rated: false, clientRating: undefined, clientFeedback: undefined
                };

                onClose();
                viewRequestDetails(dummyReq);
            } catch (err: any) {
                console.error("Failed to create request:", err);
                const msg = err?.message || err?.toString() || '';
                // Order matters: the standing refusal also contains "Action Blocked", so it
                // has to be matched FIRST or it renders as the active-request copy — telling a
                // permanently-blocked account to wait for a request it does not have.
                if (msg.toLowerCase().includes('standing')) {
                    setSubmissionError('Your standing is too low to raise a service request. Contact command to have it reviewed — retrying will not help.');
                } else if (msg.toLowerCase().includes('already have an active') || msg.toLowerCase().includes('action blocked')) {
                    setSubmissionError('You already have an active service request. Please use "Log Ad-Hoc" for additional requests, or wait for your current request to complete.');
                } else {
                    setSubmissionError('Failed to create request. Please try again or contact support if the issue persists.');
                }
            } finally {
                setIsLoading(false);
            }
        }
    }, [createRequest, serviceType, location, description, urgency, threatLevel, partyInfo, partyHandles, onClose, viewRequestDetails, currentUser, refreshRequests]);

    // Check for Low Reputation Standing
    // Shared with the server (lib/requestLifecycle.ts). Behaviour-identical to the old
    // inline `reputation <= 10`, because types.ts declares reputation as a required number
    // and the mapper coerces a missing column to 0.
    if (currentUser && !mayRaiseRequest(currentUser.reputation)) {
        return (
            <WindowFrame
                isOpen={isOpen}
                onClose={onClose}
                title="Access Restricted"
                subtitle="Standing Protocol"
                icon="fa-solid fa-user-lock"
                color="red"
                width="max-w-md"
            >
                <div className="flex flex-col items-center justify-center p-8 text-center space-y-6">
                    <div className="w-20 h-20 bg-red-500/10 rounded-full flex items-center justify-center text-red-500 border border-red-500/20 shadow-[0_0_30px_rgba(239,68,68,0.1)]">
                        <i className="fa-solid fa-user-lock text-4xl"></i>
                    </div>
                    <div>
                        <h3 className="text-white font-bold text-xl uppercase tracking-wider">Service Access Restricted</h3>
                        <p className="text-slate-400 text-sm mt-3 leading-relaxed">
                            Your account reputation standing is currently too low to initiate automated service requests.
                            Please contact <span className="text-white font-bold">{brandingConfig.name || 'Organisation'}</span> command via Discord to review your standing.
                        </p>
                    </div>
                    <a
                        href={heroCardConfig.discordUrl || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full py-4 bg-slate-800 hover:bg-slate-700 text-white font-bold rounded-lg text-xs uppercase tracking-[0.2em] flex items-center justify-center group transition-all"
                    >
                        <i className="fa-brands fa-discord mr-2 text-base group-hover:animate-pulse"></i> Open Discord Uplink
                    </a>
                    <p className="text-[10px] text-slate-600 font-mono uppercase tracking-widest">ERROR_CODE: REP_LOW_RESTRICT</p>
                </div>
            </WindowFrame>
        );
    }

    // Check for Existing Active Request
    if (isClient && clientHasActiveRequest) {
        return (
            <WindowFrame
                isOpen={isOpen}
                onClose={onClose}
                title="Active Request Found"
                subtitle="System Override"
                icon="fa-solid fa-ban"
                color="slate"
                width="max-w-md"
            >
                <div className="flex flex-col items-center justify-center p-8 text-center space-y-6 h-full">
                    <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center text-slate-500 mb-2 ring-4 ring-slate-800 shadow-inner">
                        <i className="fa-solid fa-spinner animate-spin-slow text-3xl"></i>
                    </div>
                    <div>
                        <h3 className="text-white font-bold text-xl">Mission In Progress</h3>
                        <p className="text-slate-400 text-sm mt-3 leading-relaxed">
                            You already have an active service request in the queue.
                            Please wait for your current operation to conclude before submitting a new one.
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-full py-4 bg-slate-800 hover:bg-slate-700 text-white font-bold rounded-lg text-xs uppercase tracking-[0.2em] flex items-center justify-center group transition-all"
                    >
                        Acknowledge
                    </button>
                </div>
            </WindowFrame>
        );
    }

    // Availability unknown: the server's probe faulted. Deny the form — unknown must
    // not widen — but do NOT tell the customer there is nobody on duty, which would
    // assert a fact we do not have. Retry re-runs the {force:true} refreshMainState()
    // the mount effect above uses.
    if (isClient && anyStaffOnDuty === null) {
        return (
            <WindowFrame
                isOpen={isOpen}
                onClose={onClose}
                title="Availability Unknown"
                subtitle="Could not confirm unit availability"
                icon="fa-solid fa-triangle-exclamation"
                color="slate"
                width="max-w-md"
            >
                <div className="p-6 text-center space-y-4">
                    <p className="text-slate-400 text-sm leading-relaxed">
                        We could not confirm whether any {brandingConfig.name || 'organization'} units are on duty.
                    </p>
                    <button
                        type="button"
                        onClick={() => { void refreshMainState(); }}
                        className="text-xs font-bold text-sky-400 hover:text-white uppercase tracking-widest"
                    >
                        Retry
                    </button>
                </div>
            </WindowFrame>
        );
    }

    // Check for No Service Availability for Clients
    if (isClient && !anyStaffOnDuty) {
        return (
            <WindowFrame
                isOpen={isOpen}
                onClose={onClose}
                title="Service Unavailable"
                subtitle="Offline Status"
                icon="fa-solid fa-store-slash"
                color="slate"
                width="max-w-md"
            >
                <div className="flex flex-col items-center justify-center p-8 text-center space-y-6 h-full">
                    <div className="w-20 h-20 bg-slate-800 rounded-full flex items-center justify-center text-slate-500 mb-2 ring-4 ring-slate-800 shadow-inner">
                        <i className="fa-solid fa-store-slash text-3xl"></i>
                    </div>
                    <div>
                        <h3 className="text-white font-bold text-xl">No Units Available</h3>
                        <p className="text-slate-400 text-sm mt-3 leading-relaxed">
                            There are currently no {brandingConfig.name || 'organization'} units on duty to respond to new requests.
                            Please check back later or contact us via Discord for immediate assistance.
                        </p>
                    </div>
                    <a
                        href={heroCardConfig.discordUrl || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full py-4 bg-slate-800 hover:bg-slate-700 text-white font-bold rounded-lg text-xs uppercase tracking-[0.2em] flex items-center justify-center group transition-all"
                    >
                        <i className="fa-brands fa-discord mr-2 text-base group-hover:animate-pulse"></i> Contact Command
                    </a>
                </div>
            </WindowFrame>
        );
    }

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-sky-500 focus:ring-1 focus:ring-sky-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Create Service Request"
            subtitle="New Mission Profile"
            icon="fa-solid fa-satellite-dish"
            color="sky"
            width="max-w-xl"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-5">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        <div>
                            <label className={labelClass}>Service Type</label>
                            <select
                                value={serviceType}
                                onChange={(e) => setServiceType(e.target.value)}
                                className={inputClass}
                                disabled={isLoading}
                            >
                                {activeServiceTypes.map(t => (
                                    <option key={t.id} value={t.name}>{t.name}</option>
                                ))}
                            </select>
                        </div>
                        {!isClient && (
                            <div>
                                <label className={labelClass}>Urgency</label>
                                <select
                                    value={urgency}
                                    onChange={(e) => setUrgency(e.target.value as UrgencyLevel)}
                                    className={inputClass}
                                    disabled={isLoading}
                                >
                                    {Object.values(UrgencyLevel).map(level => <option key={level} value={level}>{level}</option>)}
                                </select>
                            </div>
                        )}
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                        <div>
                            <label className={labelClass}>Location</label>
                            <LocationInput value={location} onChange={setLocation} disabled={isLoading} />
                        </div>
                        <div>
                            <label className={labelClass}>Threat Level</label>
                            <select
                                value={threatLevel}
                                onChange={(e) => setThreatLevel(e.target.value as ThreatLevel)}
                                className={inputClass}
                                disabled={isLoading}
                            >
                                {Object.values(ThreatLevel).map(level => <option key={level} value={level}>{level}</option>)}
                            </select>
                        </div>
                    </div>

                    {/* Party Section */}
                    <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/50">
                        <label className={labelClass}>Additional Party Members</label>
                        <div className="flex gap-2 mb-3">
                            <input
                                type="text"
                                value={currentHandle}
                                onChange={(e) => setCurrentHandle(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleAddHandle(e); }}
                                placeholder="RSI Handle (e.g. Maverick)"
                                className={inputClass}
                                disabled={isLoading}
                            />
                            <button
                                type="button"
                                onClick={handleAddHandle}
                                disabled={!currentHandle.trim() || isLoading}
                                className="px-4 bg-slate-700 hover:bg-slate-600 text-sky-400 rounded-lg transition-colors border border-slate-600"
                            >
                                <i className="fa-solid fa-plus"></i>
                            </button>
                        </div>

                        <div className="flex flex-wrap gap-2 mb-3">
                            {partyHandles.map(handle => (
                                <span key={handle} className="bg-slate-900 text-slate-300 px-2 py-1 rounded-sm text-xs border border-slate-700 flex items-center">
                                    {handle}
                                    <button onClick={() => handleRemoveHandle(handle)} className="ml-2 text-red-400 hover:text-red-300"><i className="fa-solid fa-xmark"></i></button>
                                </span>
                            ))}
                        </div>
                        <input
                            type="text"
                            value={partyInfo}
                            onChange={(e) => setPartyInfo(e.target.value)}
                            placeholder="Party Status / Context (e.g. All injured, 1 ship)"
                            className={inputClass}
                            disabled={isLoading}
                        />
                    </div>

                    <div>
                        <label className={labelClass}>Description</label>
                        <textarea
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={4}
                            placeholder="Provide detailed briefing..."
                            className={`${inputClass} resize-none`}
                            required
                            disabled={isLoading}
                        />
                    </div>

                    {isClient && (
                        <label className="flex items-center space-x-3 text-slate-300 cursor-pointer group p-2 rounded-sm hover:bg-slate-800/50 transition-colors">
                            <input
                                type="checkbox"
                                checked={tosAgreed}
                                onChange={(e) => setTosAgreed(e.target.checked)}
                                className="h-4 w-4 rounded-sm bg-slate-900 border-slate-600 text-sky-500 focus:ring-sky-500 transition-colors"
                                disabled={isLoading}
                            />
                            <span className="text-xs">I agree to the Terms of Service.</span>
                        </label>
                    )}
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex flex-col gap-3 rounded-b-xl">
                    {submissionError && (
                        <div className="flex items-start gap-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                            <i className="fa-solid fa-circle-exclamation text-red-400 mt-0.5 shrink-0"></i>
                            <div className="flex-1">
                                <p className="text-sm text-red-300">{submissionError}</p>
                            </div>
                            <button onClick={() => setSubmissionError(null)} className="text-red-400/60 hover:text-red-300 shrink-0">
                                <i className="fa-solid fa-xmark text-xs"></i>
                            </button>
                        </div>
                    )}
                    <div className="flex justify-end gap-3">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors"
                        disabled={isLoading}
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={isLoading || (isClient && !tosAgreed)}
                        className="px-6 py-2 bg-sky-500/10 text-sky-400 border border-sky-500/50 hover:bg-sky-500/20 hover:shadow-[0_0_15px_rgba(14,165,233,0.3)] rounded-lg text-xs font-bold uppercase tracking-wider transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Submit Request'}
                    </button>
                    </div>
                </div>
            </form>
        </WindowFrame>
    );
};

export default CreateRequestModal;
