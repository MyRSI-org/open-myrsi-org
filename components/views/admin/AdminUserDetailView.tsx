
import React, { useState, useEffect, useMemo } from 'react';
import { User, ConductRecordType, ApplicationStatus, formatReferralSource } from '../../../types';
import { useData } from '../../../contexts/DataContext';
import { useMembers } from '../../../contexts/MembersContext';
import { useHR } from '../../../contexts/HRContext';
import { useAuth, useFormatDate } from '../../../contexts/AuthContext';
import AwardIcon from '../../common/AwardIcon';
import HeroShell from '../../shared/ui/HeroShell';
import HeroStat from '../../shared/ui/HeroStat';
import HeroActionButton from '../../shared/ui/HeroActionButton';
import { AccentKey } from '../../shared/ui/accents';
import { useNotification } from '../../../contexts/NotificationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

interface AdminUserDetailViewProps {
    user: User;
    onBack: () => void;
    openReputationHistoryModal: (user: User) => void;
    openRatingHistoryModal: (user: User) => void;
    openAdjustReputationModal: (user: User) => void;
    openAwardSingleCertModal: (user: User) => void;
    openAwardSingleCommendModal: (user: User) => void;
    openAddConductEntryModal: (user: User) => void;
}

// Maps a clearance level to the shared HeroStat accent colour.
const clearanceAccent = (level?: number): AccentKey => {
    switch (level) {
        case 1: return 'emerald';
        case 2: return 'sky';
        case 3: return 'amber';
        case 4: return 'amber';
        case 5: return 'red';
        default: return 'slate';
    }
};

// Section card chrome shared with other detail views. Local copy to avoid a
// new shared dependency.
const SectionCard: React.FC<{
    title: string;
    icon: string;
    accent?: 'sky' | 'amber' | 'emerald' | 'red';
    children: React.ReactNode;
    contentClassName?: string;
    actions?: React.ReactNode;
}> = ({ title, icon, accent = 'sky', children, contentClassName, actions }) => {
    const accents = {
        sky: { bg: 'bg-sky-500/10', border: 'border-sky-500/30', text: 'text-sky-300' },
        amber: { bg: 'bg-amber-500/10', border: 'border-amber-500/30', text: 'text-amber-300' },
        emerald: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-300' },
        red: { bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-300' },
    } as const;
    const a = accents[accent];
    return (
        <div className="bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-white/5 bg-white/5 flex items-center gap-3">
                <div className={`h-8 w-8 rounded-lg ${a.bg} border ${a.border} flex items-center justify-center shrink-0`}>
                    <i className={`fa-solid ${icon} ${a.text} text-sm`}></i>
                </div>
                <h3 className="text-xs font-black uppercase tracking-widest text-slate-200 flex-1 truncate">{title}</h3>
                {actions}
            </div>
            <div className={contentClassName ?? 'p-5 space-y-4'}>{children}</div>
        </div>
    );
};

type Tab = 'profile' | 'awards' | 'conduct' | 'hr-history';

const AdminUserDetailView: React.FC<AdminUserDetailViewProps> = ({
    user,
    onBack,
    openReputationHistoryModal,
    openRatingHistoryModal,
    openAdjustReputationModal,
    openAwardSingleCertModal,
    openAwardSingleCommendModal,
    openAddConductEntryModal,
}) => {
    const { rpcAction, fetchUserDetail } = useData();
    const {
        allUsers, ranks, units, roles, securityClearances, limitingMarkers,
        updateUserRecord, updateUserClearance, revokeCertification, revokeCommendation,
    } = useMembers();
    const { hrApplicants, hrPositions } = useHR();
    const { hasPermission } = useAuth();
    const fmt = useFormatDate();
    const { addToast, confirm } = useNotification();
    const { openGenericCaseFileModal, openSecurityVettingModal } = useModalRegistry();

    // The roster cache (allUsers) holds only the lite user record; heavy nested
    // arrays are trimmed from the bulk query for egress reasons. Lazy-fetch the
    // fully-hydrated user via the user_detail endpoint.
    const cachedLite = useMemo(
        () => allUsers.find(u => u.id === user.id) || user,
        [allUsers, user]
    );
    const [fullUser, setFullUser] = useState<User | null>(null);

    // Reset the lazily-fetched detail when a different user is selected so the
    // view falls back to the lite cache immediately instead of showing the
    // previous user's hydrated record while the new fetch is in flight. Done via
    // the React "adjust state during render" pattern (prev-id tracker) so the
    // reset is applied before paint, equivalent to the old reset effect.
    const [prevUserId, setPrevUserId] = useState(user.id);
    if (user.id !== prevUserId) {
        setPrevUserId(user.id);
        setFullUser(null);
    }

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const detail = await fetchUserDetail(user.id);
            if (!cancelled && detail) setFullUser(detail);
        })();
        return () => { cancelled = true; };
    }, [user.id, cachedLite, fetchUserDetail]);

    const userToDisplay = fullUser || cachedLite;

    const [rankId, setRankId] = useState<string>(userToDisplay.rank?.id.toString() || '');
    const [unitId, setUnitId] = useState<string>(userToDisplay.unit?.id.toString() || '');
    const [positionId, setPositionId] = useState<string>(userToDisplay.position?.id.toString() || '');
    const [secondaryPositionId, setSecondaryPositionId] = useState<string>(userToDisplay.secondaryPosition?.id.toString() || '');
    const [clearanceLevelId, setClearanceLevelId] = useState<string>(userToDisplay.clearanceLevel?.id.toString() || '');
    const [selectedMarkers, setSelectedMarkers] = useState<Set<number>>(() => new Set(userToDisplay.limitingMarkers?.map(m => m.id)));
    const [adminNotes, setAdminNotes] = useState<string>(userToDisplay.adminNotes || '');
    const [personnelNotes, setPersonnelNotes] = useState<string>(userToDisplay.personnelNotes || '');
    const [roleId, setRoleId] = useState<string>(userToDisplay.roleId.toString());
    // <input type="date"> wants YYYY-MM-DD; the stored ISO is full timestamptz.
    const [tenureStartDate, setTenureStartDate] = useState<string>(userToDisplay.tenureStartDate ? userToDisplay.tenureStartDate.substring(0, 10) : '');
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    const [activeTab, setActiveTab] = useState<Tab>('profile');

    // Resync the editable admin form to the displayed record when a different
    // user is shown (or the lite cache is replaced by the hydrated detail).
    // These are user-editable inputs, not render-derived values, so they must be
    // re-seeded on the source change; the actual persistence (incl. clearance/
    // markers via updateUserClearance) happens only in handleSave. Done via the
    // React "adjust state during render" pattern (prev-value tracker) keyed on the
    // displayed record reference — behaviour-equivalent to the old reset effect
    // (same fields, same values), applied before paint.
    const [prevUserToDisplay, setPrevUserToDisplay] = useState(userToDisplay);
    if (userToDisplay !== prevUserToDisplay) {
        setPrevUserToDisplay(userToDisplay);
        setRankId(userToDisplay.rank?.id.toString() || '');
        setUnitId(userToDisplay.unit?.id.toString() || '');
        setPositionId(userToDisplay.position?.id.toString() || '');
        setSecondaryPositionId(userToDisplay.secondaryPosition?.id.toString() || '');
        setClearanceLevelId(userToDisplay.clearanceLevel?.id.toString() || '');
        setAdminNotes(userToDisplay.adminNotes || '');
        setPersonnelNotes(userToDisplay.personnelNotes || '');
        setRoleId(userToDisplay.roleId.toString());
        setSelectedMarkers(new Set(userToDisplay.limitingMarkers?.map(m => m.id)));
        setTenureStartDate(userToDisplay.tenureStartDate ? userToDisplay.tenureStartDate.substring(0, 10) : '');
    }

    const linkedHRFiles = useMemo(() => {
        return hrApplicants.filter(app => app.linkedUserId === userToDisplay.id)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }, [hrApplicants, userToDisplay.id]);

    const clientRole = useMemo(() => {
        const byName = roles.find(r => /^client$/i.test(r.name.trim()));
        if (byName) return byName;
        const systemRoles = roles.filter(r => r.is_system).sort((a, b) => a.id - b.id);
        return systemRoles[0] || null;
    }, [roles]);
    const clientRoleId = clientRole?.id;

    const sortedRanks = useMemo(() => [...ranks].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)), [ranks]);
    const sortedUnits = useMemo(() => [...units].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)), [units]);
    const sortedRoles = useMemo(() => [...roles].sort((a, b) => a.name.localeCompare(b.name)), [roles]);
    const sortedPositions = useMemo(() => [...hrPositions].sort((a, b) => a.name.localeCompare(b.name)), [hrPositions]);

    const handleSave = async () => {
        setIsSaving(true);
        const safeRankId = rankId ? parseInt(rankId) : null;
        const safeUnitId = unitId ? parseInt(unitId) : null;
        const safePositionId = positionId ? parseInt(positionId) : null;
        const safeSecondaryPositionId = secondaryPositionId ? parseInt(secondaryPositionId) : null;
        const safeRoleId = roleId ? parseInt(roleId) : 0;

        const detailsToUpdate: any = { adminNotes, personnelNotes };
        if (roleId !== userToDisplay.roleId.toString()) detailsToUpdate.roleId = safeRoleId;

        // Empty input clears the override; backend treats empty/null identically.
        const currentTenureIso = userToDisplay.tenureStartDate ? userToDisplay.tenureStartDate.substring(0, 10) : '';
        if (tenureStartDate !== currentTenureIso) {
            detailsToUpdate.tenureStartDate = tenureStartDate || null;
        }

        const isSelectingClient = clientRoleId != null && roleId === clientRoleId.toString();
        const wasClient = clientRoleId != null && userToDisplay.roleId === clientRoleId;
        if (!isSelectingClient) {
            detailsToUpdate.rankId = safeRankId;
            detailsToUpdate.unitId = safeUnitId;
            detailsToUpdate.positionId = safePositionId;
            detailsToUpdate.secondaryPositionId = safeSecondaryPositionId;
        } else if (!wasClient) {
            detailsToUpdate.rankId = null;
            detailsToUpdate.unitId = null;
            detailsToUpdate.positionId = null;
            detailsToUpdate.secondaryPositionId = null;
        }

        try {
            await updateUserRecord(userToDisplay.id, detailsToUpdate);

            const currentLvl = userToDisplay.clearanceLevel?.id.toString() || '';
            const newLvl = clearanceLevelId;
            const originalMarkers = new Set(userToDisplay.limitingMarkers?.map(m => m.id));
            const markersChanged = originalMarkers.size !== selectedMarkers.size || Array.from(selectedMarkers).some(id => !originalMarkers.has(id));

            if ((currentLvl !== newLvl || markersChanged) && hasPermission('admin:user:manage_clearance')) {
                const safeClearanceId = newLvl ? parseInt(newLvl) : null;
                await updateUserClearance(userToDisplay.id, safeClearanceId, Array.from(selectedMarkers));
            }

            setIsSaved(true);
            setTimeout(() => setIsSaved(false), 2000);
        } catch (err: any) {
            console.error(err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save user record changes." });
        } finally {
            setIsSaving(false);
        }
    };

    const handleDeleteConduct = async (entryId: number) => {
        const confirmed = await confirm({ title: 'Confirm Delete', message: 'Delete this conduct entry?', confirmText: 'Delete', variant: 'danger' });
        if (!confirmed) return;
        await rpcAction('admin:delete_conduct_entry', { entryId });
    };

    const toggleMarker = (id: number) => {
        setSelectedMarkers(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleViewCase = (app: any) => {
        if (app.referralSource === 'SECURITY_VETTING') {
            openSecurityVettingModal(app);
        } else {
            openGenericCaseFileModal(app);
        }
    };

    const tabBar = (
        <div className="flex">
            {([
                { id: 'profile', label: 'Service Data', icon: 'fa-id-card' },
                { id: 'awards', label: 'Credentials & Awards', icon: 'fa-medal' },
                { id: 'conduct', label: 'Conduct Record', icon: 'fa-gavel' },
                { id: 'hr-history', label: 'HR Case History', icon: 'fa-folder-tree' },
            ] as { id: Tab; label: string; icon: string }[]).map(tab => (
                <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-widest border-b-2 transition-colors whitespace-nowrap ${
                        activeTab === tab.id
                            ? 'text-sky-300 border-sky-400'
                            : 'text-slate-500 border-transparent hover:text-slate-300'
                    }`}
                >
                    <i className={`fa-solid ${tab.icon}`}></i>
                    {tab.label}
                </button>
            ))}
        </div>
    );

    const positionLabel = userToDisplay.position?.name || userToDisplay.jobTitle || 'N/A';
    const heroSubtitle = userToDisplay.rsiHandle;

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <HeroShell
                chipLabel={`MEMBER RECORD · ID ${userToDisplay.id.toString().padStart(6, '0')}`}
                chipIcon="fa-id-card"
                chipAccent="sky"
                chipPulse={userToDisplay.isDuty}
                title={userToDisplay.name}
                subtitle={heroSubtitle}
                actions={<>
                    <button
                        onClick={onBack}
                        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-900/60 text-slate-300 border border-slate-700 hover:text-white hover:border-sky-500/30 text-[10px] font-black uppercase tracking-wider transition-colors"
                    >
                        <i className="fa-solid fa-arrow-left"></i> Return to Roster
                    </button>
                    <HeroActionButton
                        onClick={handleSave}
                        accent={isSaved ? 'emerald' : 'sky'}
                        icon={isSaving ? 'fa-circle-notch fa-spin' : isSaved ? 'fa-check' : 'fa-floppy-disk'}
                        disabled={isSaving || isSaved}
                    >
                        {isSaving ? 'Saving...' : isSaved ? 'Saved' : 'Save Changes'}
                    </HeroActionButton>
                </>}
                statsCols={4}
                stats={<>
                    <HeroStat icon="fa-medal" label="Rank" value={userToDisplay.rank?.name || 'Unranked'} accent="sky" />
                    <HeroStat icon="fa-people-group" label="Unit" value={userToDisplay.unit?.name || 'Unassigned'} accent="indigo" />
                    <HeroStat icon="fa-briefcase" label="Position" value={positionLabel} accent="sky" />
                    <HeroStat
                        icon="fa-lock"
                        label="Clearance"
                        value={userToDisplay.clearanceLevel ? `L${userToDisplay.clearanceLevel.level} ${userToDisplay.clearanceLevel.name}` : 'None'}
                        accent={clearanceAccent(userToDisplay.clearanceLevel?.level)}
                        emphasize={!!userToDisplay.clearanceLevel}
                    />
                </>}
                tabs={tabBar}
            />

            <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar p-4 sm:p-6">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 min-w-0">
                    {/* Main column */}
                    <div className="lg:col-span-2 space-y-6">
                        {activeTab === 'profile' && (
                            <SectionCard title="Assignment & Access" icon="fa-id-card" accent="sky">
                                <div className="relative">
                                    {isSaving && (
                                        <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-xs z-10 rounded-lg flex items-center justify-center -m-2 p-2">
                                            <div className="flex flex-col items-center gap-3">
                                                <i className="fa-solid fa-circle-notch animate-spin text-sky-300 text-2xl"></i>
                                                <span className="text-xs font-bold text-sky-300 uppercase tracking-widest">Saving Changes</span>
                                            </div>
                                        </div>
                                    )}
                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                        <div>
                                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">System Role</label>
                                            <select value={roleId} onChange={e => setRoleId(e.target.value)} disabled={!hasPermission('admin:user:update_role') || isSaving} className="w-full bg-slate-950/60 border border-slate-700 rounded-lg p-2.5 text-white focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/30 outline-hidden text-sm">
                                                {sortedRoles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Rank</label>
                                            <select value={rankId} onChange={e => setRankId(e.target.value)} disabled={!hasPermission('admin:user:update') || isSaving} className="w-full bg-slate-950/60 border border-slate-700 rounded-lg p-2.5 text-white focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/30 outline-hidden text-sm">
                                                <option value="">Unranked</option>
                                                {sortedRanks.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Unit Assignment</label>
                                            <select value={unitId} onChange={e => setUnitId(e.target.value)} disabled={!hasPermission('admin:user:update') || isSaving} className="w-full bg-slate-950/60 border border-slate-700 rounded-lg p-2.5 text-white focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/30 outline-hidden text-sm">
                                                <option value="">Unassigned</option>
                                                {sortedUnits.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Primary Position</label>
                                            <select value={positionId} onChange={e => setPositionId(e.target.value)} disabled={!hasPermission('admin:user:update') || isSaving} className="w-full bg-slate-950/60 border border-slate-700 rounded-lg p-2.5 text-white focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/30 outline-hidden text-sm">
                                                <option value="">No Role</option>
                                                {sortedPositions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Secondary Position (Optional)</label>
                                            <select value={secondaryPositionId} onChange={e => setSecondaryPositionId(e.target.value)} disabled={!hasPermission('admin:user:update') || isSaving} className="w-full bg-slate-950/60 border border-slate-700 rounded-lg p-2.5 text-white focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/30 outline-hidden text-sm">
                                                <option value="">None</option>
                                                {sortedPositions.filter(p => p.id.toString() !== positionId).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                            </select>
                                        </div>
                                    </div>

                                    {/* Security Profile */}
                                    <div className="mt-5 bg-slate-950/40 p-4 rounded-lg border border-red-500/15">
                                        <h4 className="text-[10px] font-black text-red-300 uppercase tracking-widest mb-3 flex items-center">
                                            <i className="fa-solid fa-lock mr-2"></i> Security Profile
                                        </h4>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Clearance Level</label>
                                                <select
                                                    value={clearanceLevelId}
                                                    onChange={e => setClearanceLevelId(e.target.value)}
                                                    disabled={!hasPermission('admin:user:manage_clearance') || isSaving}
                                                    className="w-full bg-slate-950/60 border border-slate-700 rounded-lg p-2.5 text-white focus:border-red-500/40 focus:ring-1 focus:ring-red-500/30 outline-hidden text-sm"
                                                >
                                                    <option value="">No Clearance</option>
                                                    {securityClearances.map(c => (
                                                        <option key={c.id} value={c.id}>
                                                            Level {c.level} {'//'} {c.name}
                                                        </option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div>
                                                <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">Limiting Markers</label>
                                                <div className="flex flex-wrap gap-2">
                                                    {limitingMarkers.map(m => {
                                                        const isSelected = selectedMarkers.has(m.id);
                                                        return (
                                                            <button
                                                                key={m.id}
                                                                onClick={() => toggleMarker(m.id)}
                                                                disabled={!hasPermission('admin:user:manage_clearance') || isSaving}
                                                                className={`text-[10px] uppercase font-bold px-2 py-1 rounded border transition-colors ${isSelected
                                                                        ? 'bg-amber-500/20 text-amber-200 border-amber-500/50'
                                                                        : 'bg-slate-900/60 text-slate-500 border-slate-700 hover:bg-slate-800/60'
                                                                    }`}
                                                                title={m.description}
                                                            >
                                                                {m.code}
                                                            </button>
                                                        );
                                                    })}
                                                    {limitingMarkers.length === 0 && <span className="text-xs text-slate-600 italic">No markers defined.</span>}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="mt-5">
                                        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                                            Personnel Notes <span className="text-slate-600 font-normal normal-case ml-2">(Visible to member & command)</span>
                                        </label>
                                        <textarea value={personnelNotes} onChange={e => setPersonnelNotes(e.target.value)} rows={4} className="w-full bg-slate-950/40 border border-slate-800 rounded-lg p-3 text-white text-sm focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/30 outline-hidden resize-none" disabled={!hasPermission('user:manage:personnel_notes') || isSaving} />
                                    </div>

                                    <div className="mt-5">
                                        <label className="block text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1.5">
                                            Tenure Start Date <span className="text-slate-600 font-normal normal-case ml-2">(Override for "member since" — leave blank to use account creation date)</span>
                                        </label>
                                        <input
                                            type="date"
                                            value={tenureStartDate}
                                            onChange={e => setTenureStartDate(e.target.value)}
                                            disabled={!hasPermission('admin:user:update') || isSaving}
                                            className="w-full md:w-1/2 bg-slate-950/40 border border-slate-800 rounded-lg p-2.5 text-white text-sm focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/30 outline-hidden"
                                        />
                                    </div>

                                    <div className="pt-4 flex justify-end">
                                        <button onClick={handleSave} disabled={isSaving || isSaved} className={`px-6 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all flex items-center gap-2 ${isSaved ? 'bg-emerald-600 text-white border border-emerald-500' : 'bg-sky-600 hover:bg-sky-500 text-white border border-sky-500/40 shadow-lg shadow-sky-900/20'} disabled:opacity-50 disabled:cursor-not-allowed`}>
                                            {isSaving && <i className="fa-solid fa-circle-notch animate-spin"></i>}
                                            {isSaved && <i className="fa-solid fa-check"></i>}
                                            {!isSaving && !isSaved && <i className="fa-solid fa-floppy-disk"></i>}
                                            {isSaving ? 'Saving...' : isSaved ? 'Saved Successfully' : 'Save Changes'}
                                        </button>
                                    </div>
                                </div>
                            </SectionCard>
                        )}

                        {activeTab === 'awards' && (
                            <div className="space-y-6">
                                <SectionCard
                                    title="Certifications"
                                    icon="fa-certificate"
                                    accent="emerald"
                                    actions={
                                        <button onClick={() => openAwardSingleCertModal(userToDisplay)}
                                            className="text-[10px] font-bold text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 px-3 py-1.5 rounded-sm uppercase tracking-wider transition-colors">
                                            <i className="fa-solid fa-plus mr-1"></i> Award Cert
                                        </button>
                                    }
                                >
                                    {userToDisplay.certifications && userToDisplay.certifications.length > 0 ? (
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                            {userToDisplay.certifications.map(cert => (
                                                <div key={cert.id} className="bg-slate-950/40 border border-slate-800 p-3 rounded-lg flex items-center justify-between">
                                                    <div className="flex items-center gap-3">
                                                        <AwardIcon imageUrl={cert.imageUrl} icon={cert.icon} fallbackIcon="fa-solid fa-certificate" className="text-emerald-300 w-4 h-4 inline-block" alt={cert.name} />
                                                        <span className="font-bold text-slate-200 text-sm">{cert.name}</span>
                                                    </div>
                                                    <button
                                                        onClick={async () => { const confirmed = await confirm({ title: 'Confirm Revoke', message: 'Revoke this certification?', confirmText: 'Revoke', variant: 'danger' }); if (confirmed) revokeCertification(userToDisplay.id, cert.id); }}
                                                        className="text-slate-600 hover:text-red-400 p-1"
                                                    >
                                                        <i className="fa-solid fa-trash-can text-xs"></i>
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    ) : <p className="text-slate-500 italic text-sm">No certifications on file.</p>}
                                </SectionCard>

                                <SectionCard
                                    title="Commendations"
                                    icon="fa-medal"
                                    accent="amber"
                                    actions={
                                        <button onClick={() => openAwardSingleCommendModal(userToDisplay)}
                                            className="text-[10px] font-bold text-amber-300 hover:text-amber-200 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 px-3 py-1.5 rounded-sm uppercase tracking-wider transition-colors">
                                            <i className="fa-solid fa-plus mr-1"></i> Award Medal
                                        </button>
                                    }
                                >
                                    {userToDisplay.commendations && userToDisplay.commendations.length > 0 ? (
                                        <div className="space-y-3">
                                            {userToDisplay.commendations.map(c => (
                                                <div key={c.id} className="bg-slate-950/40 border border-slate-800 p-4 rounded-lg flex items-start gap-4">
                                                    <div className="text-amber-400 text-2xl pt-1 w-6 h-6 flex items-center justify-center overflow-hidden">
                                                        <AwardIcon imageUrl={c.imageUrl} icon={c.icon} fallbackIcon="fa-solid fa-medal" className="max-w-full max-h-full" alt={c.name} />
                                                    </div>
                                                    <div className="flex-1">
                                                        <div className="flex justify-between items-start gap-3">
                                                            <h4 className="font-bold text-white">{c.name}</h4>
                                                            <button
                                                                onClick={async () => { const confirmed = await confirm({ title: 'Confirm Revoke', message: 'Revoke this commendation?', confirmText: 'Revoke', variant: 'danger' }); if (confirmed) revokeCommendation(c.id); }}
                                                                className="text-slate-600 hover:text-red-400 p-1 shrink-0"
                                                            >
                                                                <i className="fa-solid fa-trash-can text-xs"></i>
                                                            </button>
                                                        </div>
                                                        <p className="text-sm text-slate-400 italic mt-1 wrap-break-word">"{c.reason}"</p>
                                                        <p className="text-[10px] text-slate-600 mt-2 font-mono uppercase">Awarded {fmt(c.awardedAt)}</p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    ) : <p className="text-slate-500 italic text-sm">No commendations awarded.</p>}
                                </SectionCard>
                            </div>
                        )}

                        {activeTab === 'conduct' && (
                            <SectionCard
                                title="Conduct Record"
                                icon="fa-gavel"
                                accent="red"
                                actions={
                                    <button onClick={() => openAddConductEntryModal(userToDisplay)}
                                        className="text-[10px] font-bold text-red-300 hover:text-red-200 bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 px-3 py-1.5 rounded-sm uppercase tracking-wider transition-colors">
                                        <i className="fa-solid fa-plus mr-1"></i> Add Entry
                                    </button>
                                }
                            >
                                {userToDisplay.conductRecord && userToDisplay.conductRecord.length > 0 ? (
                                    <div className="space-y-3">
                                        {userToDisplay.conductRecord.map(entry => (
                                            <div key={entry.id} className="bg-slate-950/40 border border-slate-800 p-4 rounded-lg">
                                                <div className="flex justify-between items-start mb-2">
                                                    <div className="flex items-center gap-2">
                                                        <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${entry.type === ConductRecordType.Commendation ? 'bg-emerald-500/10 text-emerald-400' :
                                                                entry.type === ConductRecordType.Infraction ? 'bg-red-500/10 text-red-400' :
                                                                    'bg-amber-500/10 text-amber-400'
                                                            }`}>{entry.type}</span>
                                                        <span className="text-xs text-slate-500 font-mono">{fmt(entry.createdAt)}</span>
                                                    </div>
                                                    <button onClick={() => handleDeleteConduct(entry.id)} className="text-slate-600 hover:text-red-400 p-1"><i className="fa-solid fa-trash-can text-xs"></i></button>
                                                </div>
                                                <p className="text-sm text-slate-300 wrap-break-word">{entry.reason}</p>
                                                <p className="text-[10px] text-slate-600 mt-2 uppercase">Logged By: {entry.enteredBy?.name || 'Unknown'}</p>
                                            </div>
                                        ))}
                                    </div>
                                ) : <p className="text-slate-500 italic text-sm">No conduct entries recorded.</p>}
                            </SectionCard>
                        )}

                        {activeTab === 'hr-history' && (
                            <SectionCard title="HR Case History" icon="fa-folder-tree" accent="sky">
                                {linkedHRFiles.length > 0 ? (
                                    <div className="space-y-3">
                                        {linkedHRFiles.map(app => (
                                            <div key={app.id} className="bg-slate-950/40 border border-slate-800 p-4 rounded-lg group">
                                                <div className="flex justify-between items-start mb-2 gap-3">
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-3 flex-wrap">
                                                            <span className={`text-[10px] font-black uppercase px-2 py-0.5 rounded border ${app.status === ApplicationStatus.Hired ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                                                                    app.status === ApplicationStatus.Rejected ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                                                                        'bg-slate-500/10 text-slate-300 border-slate-500/20'
                                                                }`}>
                                                                {app.status}
                                                            </span>
                                                            <span className="text-slate-300 text-sm font-bold truncate">{formatReferralSource(app.referralSource)}</span>
                                                        </div>
                                                        <p className="text-[10px] text-slate-500 font-mono mt-1">CASE: {app.id.split('-')[0]}</p>
                                                    </div>
                                                    <button
                                                        onClick={() => handleViewCase(app)}
                                                        className="text-[10px] font-bold text-sky-300 hover:text-sky-200 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 px-3 py-1.5 rounded-sm uppercase tracking-wider transition-colors shrink-0"
                                                    >
                                                        View File
                                                    </button>
                                                </div>
                                                <p className="text-sm text-slate-300 italic bg-slate-950/40 p-2 rounded-sm mt-2 wrap-break-word">"{app.notes}"</p>
                                                <p className="text-[10px] text-slate-600 mt-2 text-right">Filed: {fmt(app.createdAt)}</p>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="text-center py-12 border-2 border-dashed border-slate-800 rounded-lg">
                                        <p className="text-slate-500 font-medium italic">No HR case files linked to this member.</p>
                                    </div>
                                )}
                            </SectionCard>
                        )}
                    </div>

                    {/* Right sidebar */}
                    <div className="space-y-6 lg:sticky lg:top-0 lg:self-start">
                        <SectionCard title="Reputation" icon="fa-star" accent="amber">
                            <div className="text-center py-2">
                                <div className="text-3xl font-black text-white mb-1">{userToDisplay.reputation}</div>
                                <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Current Score</div>
                            </div>
                            <div className="space-y-2 pt-2">
                                <button onClick={() => openAdjustReputationModal(userToDisplay)} className="w-full bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-xs font-bold py-2.5 rounded-lg transition-colors uppercase tracking-wider border border-amber-500/30">
                                    <i className="fa-solid fa-sliders mr-1.5"></i> Adjust Manually
                                </button>
                                <button onClick={() => openReputationHistoryModal(userToDisplay)} className="w-full bg-slate-800/60 hover:bg-slate-700/60 text-slate-300 hover:text-white text-xs font-bold py-2.5 rounded-lg transition-colors border border-slate-700 uppercase tracking-wider">
                                    <i className="fa-solid fa-clock-rotate-left mr-1.5"></i> View History
                                </button>
                                <button onClick={() => openRatingHistoryModal(userToDisplay)} className="w-full bg-slate-800/60 hover:bg-slate-700/60 text-slate-300 hover:text-white text-xs font-bold py-2.5 rounded-lg transition-colors border border-slate-700 uppercase tracking-wider">
                                    <i className="fa-solid fa-comments mr-1.5"></i> Client Ratings
                                </button>
                            </div>
                        </SectionCard>

                        <SectionCard title="Admin Notes (Private)" icon="fa-lock" accent="red">
                            <textarea value={adminNotes} onChange={e => setAdminNotes(e.target.value)} rows={6} className="w-full bg-slate-950/40 border border-slate-800 rounded-lg p-3 text-white text-sm focus:border-red-500/40 focus:ring-1 focus:ring-red-500/30 outline-hidden resize-none" placeholder="Internal notes visible only to admins..." disabled={!hasPermission('admin:user:update')} />
                            <div className="flex justify-end">
                                <button onClick={handleSave} disabled={isSaving || isSaved} className="text-[10px] font-bold text-slate-400 hover:text-white uppercase tracking-wider disabled:opacity-50">
                                    {isSaved ? <><i className="fa-solid fa-check mr-1"></i> Saved</> : <><i className="fa-solid fa-floppy-disk mr-1"></i> Save Note</>}
                                </button>
                            </div>
                        </SectionCard>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default AdminUserDetailView;
