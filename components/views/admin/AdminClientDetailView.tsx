
import React, { useState, useMemo } from 'react';
import { User, ServiceRequestStatus } from '../../../types';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import ClientFlagPills from '../../shared/ui/ClientFlagPills';
import Switch from '../../ui/Switch';
import { useNotification } from '../../../contexts/NotificationContext';
import { useNavigation } from '../../../contexts/NavigationContext';

interface AdminClientDetailViewProps {
    user: User;
    onBack: () => void;
    openAdjustReputationModal: (user: User) => void;
    openReputationHistoryModal: (user: User) => void;
}

const getStatusChipClass = (status: ServiceRequestStatus) => {
    switch (status) {
        case ServiceRequestStatus.Success: return 'bg-green-500/10 text-green-400 border-green-500/20';
        case ServiceRequestStatus.Failed:
        case ServiceRequestStatus.Cancelled:
        case ServiceRequestStatus.Refused:
        case ServiceRequestStatus.Aborted:
            return 'bg-red-500/10 text-red-400 border-red-500/20';
        default: return 'bg-slate-600/20 text-slate-400 border-slate-600/20';
    }
};

// Section card chrome shared with other detail views. Local copy to avoid a
// new shared dependency.
const SectionCard: React.FC<{
    title: string;
    icon: string;
    accent?: 'amber' | 'sky' | 'emerald' | 'red';
    children: React.ReactNode;
    contentClassName?: string;
}> = ({ title, icon, accent = 'amber', children, contentClassName }) => {
    const accents = {
        amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-300' },
        sky: { bg: 'bg-sky-500/10', border: 'border-sky-500/30', text: 'text-sky-300' },
        emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-300' },
        red: { bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-300' },
    } as const;
    const a = accents[accent];
    return (
        <div className="bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 bg-white/5 flex items-center gap-3">
                <div className={`h-8 w-8 rounded-lg ${a.bg} border ${a.border} flex items-center justify-center`}>
                    <i className={`fa-solid ${icon} ${a.text} text-sm`}></i>
                </div>
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-200">{title}</h3>
            </div>
            <div className={contentClassName ?? 'p-5 space-y-4'}>{children}</div>
        </div>
    );
};

type Tab = 'profile' | 'history' | 'notes';

const AdminClientDetailView: React.FC<AdminClientDetailViewProps> = ({ user, onBack, openAdjustReputationModal, openReputationHistoryModal }) => {
    const { hydratedServiceRequests, rpcAction, refreshMainState } = useData();
    const { allUsers, updateUserRecord, promoteUserToMember } = useMembers();
    const { hasPermission } = useAuth();
    const { addToast, confirm } = useNotification();
    const { viewRequestDetails } = useNavigation();
    const fmt = useFormatDate();

    const userToDisplay = allUsers.find(u => u.id === user.id) || user;

    const [adminNotes, setAdminNotes] = useState<string>(userToDisplay.adminNotes || '');
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    const [isPromoting, setIsPromoting] = useState(false);
    const [isPromoted, setIsPromoted] = useState(false);
    const [activeTab, setActiveTab] = useState<Tab>('profile');

    // Reset the controlled admin-notes textarea when the displayed user changes.
    // Adjust-state-during-render (tracking the previous user reference) instead of an
    // effect: re-seeds editable local state on identity change with the exact same
    // value as the old effect, without an extra commit. (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
    const [prevUser, setPrevUser] = useState(userToDisplay);
    if (userToDisplay !== prevUser) {
        setPrevUser(userToDisplay);
        setAdminNotes(userToDisplay.adminNotes || '');
    }

    const clientStats = useMemo(() => {
        const clientRequests = hydratedServiceRequests.filter(req => req.clientId === userToDisplay.id);
        const totalRequests = clientRequests.length;
        const successfulRequests = clientRequests.filter(req => req.status === ServiceRequestStatus.Success).length;
        const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;
        return { totalRequests, successRate, requests: clientRequests };
    }, [hydratedServiceRequests, userToDisplay.id]);

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await updateUserRecord(userToDisplay.id, { adminNotes });
            setIsSaved(true);
            setTimeout(() => setIsSaved(false), 2000);
        } catch (err) {
            console.error(err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save client record changes." });
        } finally {
            setIsSaving(false);
        }
    };

    const handlePromote = async () => {
        const confirmed = await confirm({ title: 'Promote to Member', message: `Are you sure you want to promote ${userToDisplay.name} to a Member? This will grant them access to the member-level dashboard features.`, confirmText: 'Promote', variant: 'warning' });
        if (confirmed) {
            setIsPromoting(true);
            try {
                await promoteUserToMember(userToDisplay.id);
                setIsPromoted(true);
            } catch (err: any) {
                console.error(err);
                addToast("Promotion Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: err?.message || "Failed to promote the user to Member." });
            } finally {
                setIsPromoting(false);
            }
        }
    };

    // Affiliate / VIP toggles. Backend rejects flags on non-Client users, so no
    // extra role guard beyond admin:user:update is needed. refreshMainState on
    // success lands the pill update immediately if realtime is briefly disconnected.
    const [togglingAffiliate, setTogglingAffiliate] = useState(false);
    const [togglingVip, setTogglingVip] = useState(false);
    const toggleClientFlag = async (action: 'admin:toggle_affiliate' | 'admin:toggle_vip', label: string) => {
        const setBusy = action === 'admin:toggle_affiliate' ? setTogglingAffiliate : setTogglingVip;
        setBusy(true);
        try {
            await rpcAction(action, { targetUserId: userToDisplay.id });
            await refreshMainState();
        } catch (err: any) {
            addToast(`${label} Toggle Failed`, <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message || 'Could not update the flag.' });
        } finally {
            setBusy(false);
        }
    };

    const reputationColor = userToDisplay.reputation < 25 ? 'text-red-400' : userToDisplay.reputation < 50 ? 'text-amber-400' : 'text-green-400';

    const tabBar = (
        <div className="flex">
            {([
                { id: 'profile', label: 'Account Profile', icon: 'fa-id-card' },
                { id: 'history', label: 'Mission History', icon: 'fa-clock-rotate-left' },
                { id: 'notes', label: 'Administrative Notes', icon: 'fa-pen-to-square' },
            ] as { id: Tab; label: string; icon: string }[]).map(tab => (
                <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${
                        activeTab === tab.id
                            ? 'text-amber-300 border-amber-400'
                            : 'text-slate-500 border-transparent hover:text-slate-300'
                    }`}
                >
                    <i className={`fa-solid ${tab.icon}`}></i>
                    {tab.label}
                </button>
            ))}
        </div>
    );

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel={`CLIENT RECORD · ID ${userToDisplay.id.toString().padStart(6, '0')}`}
                chipIcon="fa-user-shield"
                chipAccent="amber"
                chipPulse={userToDisplay.isDuty}
                title={(
                    <span className="inline-flex items-center gap-2 flex-wrap">
                        {userToDisplay.name}
                        <ClientFlagPills isAffiliate={userToDisplay.isAffiliate} isVip={userToDisplay.isVip} size="md" />
                    </span>
                )}
                subtitle={userToDisplay.rsiHandle}
                actions={<>
                    <button
                        onClick={onBack}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/60 text-slate-300 border border-slate-700 hover:text-white hover:border-amber-500/30 text-[10px] font-black uppercase tracking-wider transition-colors"
                    >
                        <i className="fa-solid fa-arrow-left"></i> Return to Registry
                    </button>
                    {hasPermission('admin:user:update_role') && !isPromoted && (
                        <HeroActionButton
                            onClick={handlePromote}
                            accent="emerald"
                            icon={isPromoting ? 'fa-circle-notch fa-spin' : 'fa-arrow-up'}
                            disabled={isPromoting}
                        >
                            {isPromoting ? 'Promoting...' : 'Promote to Member'}
                        </HeroActionButton>
                    )}
                    {isPromoted && (
                        <span className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-[10px] font-black uppercase tracking-wider">
                            <i className="fa-solid fa-check"></i> Promoted
                        </span>
                    )}
                </>}
                statsCols={4}
                stats={<>
                    <HeroStat icon="fa-clipboard-list" label="Total Requests" value={clientStats.totalRequests} accent="amber" emphasize={clientStats.totalRequests > 0} />
                    <HeroStat icon="fa-percent" label="Success Rate" value={`${clientStats.successRate.toFixed(0)}%`} accent="emerald" emphasize={clientStats.successRate >= 75} />
                    <HeroStat icon="fa-star" label="Reputation" value={userToDisplay.reputation ?? 0} accent={userToDisplay.reputation < 25 ? 'red' : userToDisplay.reputation < 50 ? 'amber' : 'emerald'} />
                    <HeroStat icon={userToDisplay.isDuty ? 'fa-circle-check' : 'fa-circle-minus'} label="Status" value={userToDisplay.isDuty ? 'Connected' : 'Offline'} accent={userToDisplay.isDuty ? 'emerald' : 'slate'} emphasize={userToDisplay.isDuty} />
                </>}
                tabs={tabBar}
            />

            <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar p-4 sm:p-6">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-w-0">
                    {/* Main column */}
                    <div className="lg:col-span-2 space-y-6">
                        {activeTab === 'profile' && (
                            <SectionCard title="Account Integrity" icon="fa-id-card" accent="amber">
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                    <div>
                                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">RSI Handle</p>
                                        <p className="text-white font-mono text-sm">{userToDisplay.rsiHandle}</p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Discord Identifier</p>
                                        <p className="text-white font-mono text-sm">{userToDisplay.discordId}</p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Joined</p>
                                        <p className="text-white font-mono text-sm">{fmt(userToDisplay.createdAt)}</p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Role</p>
                                        <p className="text-white font-mono text-sm uppercase">{userToDisplay.role}</p>
                                    </div>
                                </div>
                                <div className="bg-slate-950/40 border border-amber-500/20 p-4 rounded-lg">
                                    <p className="text-xs text-slate-400 leading-relaxed">
                                        <i className="fa-solid fa-circle-info mr-2 text-amber-400/80"></i>
                                        Clients are managed based on their reputation score. Low reputation clients (below 10) are restricted from initiating new service requests.
                                    </p>
                                </div>
                            </SectionCard>
                        )}

                        {activeTab === 'profile' && hasPermission('admin:user:update') && (
                            <SectionCard title="Visibility Flags" icon="fa-flag" accent="amber">
                                <p className="text-xs text-slate-400 leading-relaxed">
                                    Visual-only pills shown next to this client's name in the registry, dispatch, and request views. They don't change permissions or behaviour.
                                </p>
                                <div className="space-y-3 pt-2">
                                    <Switch
                                        label="Mark as VIP"
                                        hint="Highlights this client as high-value (amber crown pill)."
                                        checked={!!userToDisplay.isVip}
                                        onChange={() => toggleClientFlag('admin:toggle_vip', 'VIP')}
                                        disabled={togglingVip}
                                        accent="amber"
                                    />
                                    <Switch
                                        label="Mark as Affiliate"
                                        hint="Identifies this client as a partner / referral relationship (purple handshake pill)."
                                        checked={!!userToDisplay.isAffiliate}
                                        onChange={() => toggleClientFlag('admin:toggle_affiliate', 'Affiliate')}
                                        disabled={togglingAffiliate}
                                        accent="purple"
                                    />
                                </div>
                            </SectionCard>
                        )}

                        {activeTab === 'history' && (
                            <SectionCard title="Mission History" icon="fa-clock-rotate-left" accent="sky" contentClassName="p-0">
                                <table className="w-full text-left">
                                    <thead>
                                        <tr className="bg-slate-950/40 border-b border-slate-800 text-slate-400 text-[10px] uppercase tracking-widest font-black">
                                            <th className="p-3 sm:p-4">Reference</th>
                                            <th className="p-3 sm:p-4">Type</th>
                                            <th className="p-3 sm:p-4">Date</th>
                                            <th className="p-3 sm:p-4 text-right">Result</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800">
                                        {clientStats.requests.map(req => (
                                            <tr key={req.id} onClick={() => viewRequestDetails(req)} className="hover:bg-slate-800/40 transition-colors cursor-pointer group">
                                                <td className="p-3 sm:p-4 font-mono text-slate-200 font-bold text-sm">#{req.id.split('-')[1]}</td>
                                                <td className="p-3 sm:p-4 text-sm text-white font-bold">{req.serviceType}</td>
                                                <td className="p-3 sm:p-4 text-sm text-slate-400 font-mono">{fmt.date(req.createdAt)}</td>
                                                <td className="p-3 sm:p-4 text-right">
                                                    <span className={`px-2 py-1 rounded-sm text-[10px] font-black uppercase tracking-wider border ${getStatusChipClass(req.status)}`}>
                                                        {req.status}
                                                    </span>
                                                </td>
                                            </tr>
                                        ))}
                                        {clientStats.requests.length === 0 && (
                                            <tr><td colSpan={4} className="p-10 text-center text-slate-500 italic">No historical requests found.</td></tr>
                                        )}
                                    </tbody>
                                </table>
                            </SectionCard>
                        )}

                        {activeTab === 'notes' && (
                            <SectionCard title="Confidential Archive Notes" icon="fa-pen-to-square" accent="amber">
                                <textarea
                                    value={adminNotes}
                                    onChange={e => setAdminNotes(e.target.value)}
                                    rows={12}
                                    className="w-full bg-slate-950/40 border border-slate-800 rounded-lg p-4 text-white text-sm focus:border-amber-500/40 focus:ring-1 focus:ring-amber-500/30 outline-hidden resize-none leading-relaxed transition-colors"
                                    placeholder="Enter internal observations..."
                                    disabled={!hasPermission('admin:user:update') || isSaving}
                                />
                                <div className="flex justify-end">
                                    <button onClick={handleSave} disabled={isSaving || isSaved || !hasPermission('admin:user:update')}
                                        className={`px-6 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all ${
                                            isSaved
                                                ? 'bg-green-600 text-white border border-green-500'
                                                : 'bg-amber-600 hover:bg-amber-500 text-white border border-amber-500/40 shadow-lg shadow-amber-900/20'
                                        } disabled:opacity-50 disabled:cursor-not-allowed`}>
                                        {isSaving ? <><i className="fa-solid fa-spinner animate-spin mr-1"></i> Saving...</> : isSaved ? <><i className="fa-solid fa-check mr-1"></i> Saved</> : <><i className="fa-solid fa-floppy-disk mr-1"></i> Commit Notes</>}
                                    </button>
                                </div>
                            </SectionCard>
                        )}
                    </div>

                    {/* Right sidebar */}
                    <div className="space-y-6 lg:sticky lg:top-0 lg:self-start">
                        <SectionCard title="Reputation Profile" icon="fa-star" accent="amber">
                            <div className="text-center py-2">
                                <div className={`text-3xl font-black mb-1 ${reputationColor}`}>
                                    {userToDisplay.reputation}
                                </div>
                                <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Active Score</div>
                            </div>
                            <div className="space-y-2 pt-2">
                                <button
                                    onClick={() => openAdjustReputationModal(userToDisplay)}
                                    disabled={!hasPermission('admin:user:adjust_reputation')}
                                    className="w-full bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-xs font-bold py-2.5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed uppercase tracking-wider border border-amber-500/30"
                                >
                                    <i className="fa-solid fa-sliders mr-1.5"></i> Adjust Rating
                                </button>
                                <button
                                    onClick={() => openReputationHistoryModal(userToDisplay)}
                                    disabled={!hasPermission('admin:user:view_history')}
                                    className="w-full bg-slate-800/60 hover:bg-slate-700/60 text-slate-300 hover:text-white text-xs font-bold py-2.5 rounded-lg transition-colors border border-slate-700 disabled:opacity-40 disabled:cursor-not-allowed uppercase tracking-wider"
                                >
                                    <i className="fa-solid fa-clock-rotate-left mr-1.5"></i> Audit History
                                </button>
                            </div>
                        </SectionCard>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AdminClientDetailView;
