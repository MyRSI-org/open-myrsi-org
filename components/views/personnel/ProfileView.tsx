import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useData } from '../../../contexts/DataContext';
import CallsignChip from '../../shared/ui/CallsignChip';
import { useNotification } from '../../../contexts/NotificationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';
import {
    formatUserDateTime,
    detectBrowserTimezone,
    getCommonTimezones,
    getAllTimezones,
    getDateFormatPresets,
    type DateFormatPreset,
} from '../../../lib/time';

const ProfileView: React.FC = () => {
    const { currentUser, initiateRsiHandleUpdate, syncCurrentUserRoles, subscribeToPush, isPushActive, checkPushSubscription, updateDisplayName, updateUserPreferences } = useAuth();
    const { addToast, confirm } = useNotification();
    const { openDeleteAccountModal } = useModalRegistry();
    const { rpcAction } = useData();
    const [isEditing, setIsEditing] = useState(false);
    const [rsiHandle, setRsiHandle] = useState(currentUser?.rsiHandle || '');

    // Display-name editor state. `null` on the user record = no override, fall
    // back to Discord-sourced `discordName`.
    const [isEditingDisplayName, setIsEditingDisplayName] = useState(false);
    const [displayNameDraft, setDisplayNameDraft] = useState(currentUser?.displayName || '');
    const [isSavingDisplayName, setIsSavingDisplayName] = useState(false);

    // Sync State
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncSuccess, setSyncSuccess] = useState(false);
    const [syncCooldown, setSyncCooldown] = useState(false);
    const [cooldownTime, setCooldownTime] = useState(0);

    const [isSaving, setIsSaving] = useState(false);

    // Confirmation Modal
    const [showHandleConfirm, setShowHandleConfirm] = useState(false);

    // Time preferences state
    const browserTz = useMemo(() => detectBrowserTimezone(), []);
    const allTimezones = useMemo(() => getAllTimezones(), []);
    const commonTimezones = useMemo(() => getCommonTimezones(), []);
    const datePresets = useMemo(() => getDateFormatPresets(), []);
    const [tzDraft, setTzDraft] = useState<string>(currentUser?.timezone || browserTz);
    const [formatDraft, setFormatDraft] = useState<DateFormatPreset>(currentUser?.dateFormat || 'compact_12h');
    const [isSavingPrefs, setIsSavingPrefs] = useState(false);
    const previewKey = [currentUser?.timezone, currentUser?.dateFormat, tzDraft, formatDraft].join(String.fromCharCode(31));
    const [prevPreviewKey, setPrevPreviewKey] = useState(previewKey);
    const [previewIso, setPreviewIso] = useState(() => new Date().toISOString());
    if (previewKey !== prevPreviewKey) {
        setPrevPreviewKey(previewKey);
        setPreviewIso(new Date().toISOString());
    }

    // Diagnostic State
    const [diagStep, setDiagStep] = useState(0); // 0: Idle, 1: Browser, 2: Permission, 3: SW, 4: Server
    // Append-only diagnostic log. Each line carries a stable, monotonically
    // minted id so duplicate text still keys uniquely (the list is only ever
    // appended to or cleared, never reordered).
    const [diagLog, setDiagLog] = useState<{ id: number; text: string }[]>([]);
    const [isDiagnosing, setIsDiagnosing] = useState(false);

    const cooldownIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const diagLineSeqRef = useRef(0);

    // Hydrate the user-editable form drafts when the profile (or the specific
    // mirrored subfields) changes. These fields are edited afterward, so they
    // can't be derived during render — instead we re-seed during render using
    // the React-documented "adjust state on prop change" pattern with a
    // previous-key tracker. The composite key mirrors EXACTLY the subfields the
    // form depends on, so an unrelated profile field update won't clobber a
    // user's in-progress draft. React applies these sets and re-renders before
    // paint, so this is behavior-equivalent to the old hydrate effect.
    const draftsKey = [
        currentUser?.id,
        currentUser?.rsiHandle,
        currentUser?.displayName,
        currentUser?.timezone,
        currentUser?.dateFormat,
        browserTz,
    ].join(String.fromCharCode(31)); // unit-separator delimiter avoids field-boundary collisions
    const [prevDraftsKey, setPrevDraftsKey] = useState(draftsKey);
    if (draftsKey !== prevDraftsKey) {
        setPrevDraftsKey(draftsKey);
        if (currentUser) {
            setRsiHandle(currentUser.rsiHandle);
            setDisplayNameDraft(currentUser.displayName || '');
            setTzDraft(currentUser.timezone || browserTz);
            setFormatDraft(currentUser.dateFormat || 'compact_12h');
        }
    }

    // Cleanup the cooldown interval on unmount. Hoisted above the early return
    // below so hook order stays stable across renders.
    useEffect(() => {
        return () => {
            if (cooldownIntervalRef.current) {
                clearInterval(cooldownIntervalRef.current);
            }
        };
    }, []);

    const saveDisplayName = async () => {
        const trimmed = displayNameDraft.trim();
        // Submit `null` to clear, else the trimmed value. Same value as current = no-op.
        const next = trimmed.length > 0 ? trimmed : null;
        if ((currentUser?.displayName || null) === next) {
            setIsEditingDisplayName(false);
            return;
        }
        setIsSavingDisplayName(true);
        try {
            await updateDisplayName(next);
            addToast(
                next ? 'Display name saved' : 'Reverted to Discord name',
                <i className="fa-solid fa-check"></i>,
                'bg-green-500/10 text-green-400 border-green-500/50',
            );
            setIsEditingDisplayName(false);
        } catch (err: any) {
            addToast(
                'Update failed',
                <i className="fa-solid fa-xmark"></i>,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not save display name.' },
            );
        } finally {
            setIsSavingDisplayName(false);
        }
    };

    const clearDisplayName = async () => {
        setDisplayNameDraft('');
        setIsSavingDisplayName(true);
        try {
            await updateDisplayName(null);
            addToast(
                'Reverted to Discord name',
                <i className="fa-solid fa-check"></i>,
                'bg-green-500/10 text-green-400 border-green-500/50',
            );
            setIsEditingDisplayName(false);
        } catch (err: any) {
            addToast(
                'Update failed',
                <i className="fa-solid fa-xmark"></i>,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Could not clear display name.' },
            );
        } finally {
            setIsSavingDisplayName(false);
        }
    };

    const savePreferences = async () => {
        const tzToSave = tzDraft === browserTz && !currentUser?.timezone ? null : tzDraft;
        const fmtToSave = formatDraft === 'compact_12h' && !currentUser?.dateFormat ? null : formatDraft;
        const tzChanged = (currentUser?.timezone || null) !== tzToSave;
        const fmtChanged = (currentUser?.dateFormat || null) !== fmtToSave;
        if (!tzChanged && !fmtChanged) {
            addToast('No changes to save', <i className="fa-solid fa-circle-info"></i>, 'bg-slate-500/10 text-slate-300 border-slate-500/40');
            return;
        }
        setIsSavingPrefs(true);
        try {
            await updateUserPreferences({
                ...(tzChanged ? { timezone: tzToSave } : {}),
                ...(fmtChanged ? { dateFormat: fmtToSave } : {}),
            });
            addToast('Time preferences saved', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50');
        } catch (err: any) {
            addToast('Save failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message || 'Could not save preferences.' });
        } finally {
            setIsSavingPrefs(false);
        }
    };

    const resetTzToBrowser = () => setTzDraft(browserTz);

    if (!currentUser) return null;

    const initiateSave = () => {
        if (rsiHandle.trim() && rsiHandle.trim() !== currentUser.rsiHandle) {
            setShowHandleConfirm(true);
        } else {
            setIsEditing(false);
        }
    };

    const confirmSave = async () => {
        setShowHandleConfirm(false);
        setIsSaving(true);
        try {
            await initiateRsiHandleUpdate(rsiHandle.trim());
            // App component will redirect to verification view automatically upon context update
        } catch (err) {
            console.error(err);
            addToast("Update Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to update your RSI handle." });
            setRsiHandle(currentUser.rsiHandle);
            setIsEditing(false);
            setIsSaving(false);
        }
    };

    const startCooldownTimer = (minutes: number) => {
        setSyncCooldown(true);
        setCooldownTime(minutes * 60);
        cooldownIntervalRef.current = setInterval(() => {
            setCooldownTime((prev) => {
                if (prev <= 1) {
                    if (cooldownIntervalRef.current) {
                        clearInterval(cooldownIntervalRef.current);
                        cooldownIntervalRef.current = null;
                    }
                    setSyncCooldown(false);
                    return 0;
                }
                return prev - 1;
            });
        }, 1000);
    };

    const handleSyncRoles = async () => {
        if (syncCooldown) return;

        setIsSyncing(true);
        setSyncSuccess(false);
        try {
            const result = await syncCurrentUserRoles();

            // Server-side cooldown enforcement
            if (typeof result === 'string' && result.startsWith('SYNC_COOLDOWN:')) {
                const remainingMin = parseInt(result.split(':')[1], 10);
                startCooldownTimer(remainingMin);
                addToast("Sync Cooldown", <i className="fa-solid fa-clock"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: `Try again in ${remainingMin} minute${remainingMin !== 1 ? 's' : ''}.` });
                return;
            }

            setSyncSuccess(true);
            setTimeout(() => setSyncSuccess(false), 3000);

            // Start cooldown timer (server enforces 1 hour, show 60 min locally)
            startCooldownTimer(60);

        } catch (error: any) {
            console.error("Failed to sync roles:", error);
            addToast("Sync Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while syncing your roles. Please try again." });
        } finally {
            setIsSyncing(false);
        }
    };

    const runDiagnostics = async () => {
        setIsDiagnosing(true);
        setDiagLog([]);
        setDiagStep(1);

        const addLog = (msg: string) => setDiagLog(prev => [...prev, { id: diagLineSeqRef.current++, text: msg }]);

        try {
            // Step 1: Browser Support
            addLog("Checking browser capability...");
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
                throw new Error("Browser does not support Push Notifications.");
            }
            addLog("✅ Browser compatible.");
            setDiagStep(2);
            await new Promise(r => setTimeout(r, 500));

            // Step 2: Permissions
            addLog("Checking permissions...");
            if (Notification.permission === 'denied') {
                throw new Error("Notifications are blocked in browser settings.");
            }
            if (Notification.permission === 'default') {
                addLog("⚠️ Permission not yet granted. Requesting...");
            } else {
                addLog("✅ Permission granted.");
            }
            setDiagStep(3);
            await new Promise(r => setTimeout(r, 500));

            // Step 3: Service Worker & Subscription
            addLog("Registering Uplink...");
            await subscribeToPush();
            addLog("✅ Device registration successful.");
            setDiagStep(4);
            await new Promise(r => setTimeout(r, 500));

            // Step 4: Server Verification
            addLog("Verifying with Command...");
            const isServerAware = await checkPushSubscription();
            if (isServerAware) {
                addLog("✅ Command acknowledges link. Ready.");
            } else {
                throw new Error("Server could not verify subscription.");
            }
            setDiagStep(5); // Complete
            addToast("Device Registered", <i className="fa-solid fa-circle-check"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: "Push notifications are now active on this device." });

        } catch (err: any) {
            addLog(`❌ ERROR: ${err.message}`);
            setDiagStep(0); // Fail state
        } finally {
            setIsDiagnosing(false);
        }
    };

    const handleTestSignal = async () => {
        addToast("Test Signal", <i className="fa-solid fa-satellite-dish"></i>, "bg-sky-500/10 text-sky-400 border-sky-500/50", { description: "Requesting test signal from command..." });
        try {
            await rpcAction('user:test_push', { userId: currentUser.id });
        } catch (e: any) {
            addToast("Signal Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: `${e.message || 'Unknown network error'}. Ensure you have 'Registered' this specific browser first.` });
        }
    };

    const getReputationClass = (rep: number) => {
        if (rep < 10) return 'text-red-600';
        if (rep <= 15) return 'text-red-500';
        if (rep < 25) return 'text-red-400';
        if (rep < 50) return 'text-amber-400';
        return 'text-green-400';
    };

    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <div className="shrink-0 relative overflow-hidden border-b border-white/5 bg-linear-to-b from-sky-950/30 via-slate-950/80 to-slate-950">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-sky-500/10 rounded-full blur-[120px] pointer-events-none" aria-hidden />

                <div className="relative px-4 sm:px-8 pt-10 pb-8">
                    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
                        <div className="min-w-0">
                            <CallsignChip label="MODULE · MY ACCOUNT" icon="fa-id-card" accent="sky" pulse />
                            <h1 className="mt-3 text-3xl sm:text-4xl font-black text-white tracking-tight leading-tight">
                                My Account
                            </h1>
                            <p className="mt-2 text-sm text-slate-400 max-w-2xl">
                                Identity, account settings, and device registration. Manage how the platform recognizes you.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6 max-w-5xl mx-auto w-full">

                <div className="bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl p-6 md:p-8 relative overflow-hidden shadow-lg">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-sky-500/10 blur-[100px] rounded-full pointer-events-none -translate-y-1/2 translate-x-1/2"></div>

                    <div className="relative z-10 flex flex-col md:flex-row items-center md:items-start gap-6 md:gap-8">
                        <div className="relative group">
                            <div className="absolute -inset-0.5 bg-linear-to-br from-sky-500 to-indigo-500 rounded-full blur-sm opacity-50 group-hover:opacity-100 transition duration-500"></div>
                            <img src={currentUser.avatarUrl} alt={currentUser.name} className="relative w-28 h-28 md:w-32 md:h-32 rounded-full border-4 border-slate-900 object-cover shadow-xl" />
                            {currentUser.rank?.iconUrl && (
                                <div className="absolute bottom-0 right-0 bg-slate-900 rounded-full p-1.5 border border-slate-700 shadow-lg" title={currentUser.rank.name}>
                                    <img src={currentUser.rank.iconUrl} className="w-8 h-8 object-contain" alt="Rank" />
                                </div>
                            )}
                        </div>

                        <div className="flex-1 text-center md:text-left space-y-4 w-full">
                            <div>
                                <h2 className="text-2xl md:text-3xl font-black text-white tracking-tight uppercase">{currentUser.name}</h2>
                                <div className="flex flex-wrap justify-center md:justify-start items-center gap-3 mt-2">
                                    <span className="font-mono text-sky-300 text-base md:text-lg tracking-wider">{currentUser.rsiHandle}</span>
                                    <span className="text-slate-600">|</span>
                                    <span className="text-slate-400 font-black text-xs uppercase tracking-widest">{currentUser.rank?.name || currentUser.role}</span>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <div className="bg-slate-950/40 p-3 rounded-xl border border-white/10">
                                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1.5">Unit</p>
                                    <p className="text-white font-bold truncate text-sm">{currentUser.unit?.name || 'Unassigned'}</p>
                                </div>
                                <div className="bg-slate-950/40 p-3 rounded-xl border border-white/10">
                                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1.5">Position</p>
                                    <p className="text-white font-bold truncate text-sm">{currentUser.position?.name || 'Standard'}</p>
                                </div>
                                <div className="bg-slate-950/40 p-3 rounded-xl border border-white/10">
                                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1.5">Clearance</p>
                                    <p className="text-white font-bold truncate text-sm">{currentUser.clearanceLevel?.name || 'None'}</p>
                                </div>
                                <div className="bg-slate-950/40 p-3 rounded-xl border border-white/10">
                                    <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1.5">Reputation</p>
                                    <p className={`font-black text-xl font-mono leading-none ${getReputationClass(currentUser.reputation)}`}>{currentUser.reputation}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                    <div className="bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden">
                        <div className="px-5 py-4 border-b border-white/5 bg-white/5 flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-400">
                                <i className="fa-solid fa-sliders text-sm"></i>
                            </div>
                            <h3 className="font-bold text-white text-sm uppercase tracking-wider">Account Settings</h3>
                        </div>

                        <div className="p-5 space-y-6">
                            <div>
                                <div className="flex justify-between items-center mb-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">RSI Handle</label>
                                    {!isEditing && (
                                        <button onClick={() => setIsEditing(true)} className="text-sky-300 hover:text-sky-200 text-[10px] font-black uppercase tracking-widest transition-colors">
                                            Change
                                        </button>
                                    )}
                                </div>
                                {isEditing ? (
                                    <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-700 space-y-3 animate-fade-in">
                                        <input
                                            type="text"
                                            value={rsiHandle}
                                            onChange={(e) => setRsiHandle(e.target.value)}
                                            className="w-full bg-slate-900/60 border border-slate-700 rounded-lg p-3 text-white text-sm font-mono focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/30 outline-hidden transition-all"
                                            autoFocus
                                        />
                                        <div className="flex gap-2">
                                            <button onClick={initiateSave} disabled={isSaving} className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-sky-600 hover:bg-sky-500 border border-sky-500/40 rounded-lg shadow-lg shadow-sky-900/30 transition disabled:opacity-50">
                                                {isSaving ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-check"></i> Verify & Save</>}
                                            </button>
                                            <button onClick={() => { setIsEditing(false); setRsiHandle(currentUser.rsiHandle); }} className="flex-1 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-slate-300 bg-slate-900/60 border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors">
                                                Cancel
                                            </button>
                                        </div>
                                        <p className="text-[10px] text-amber-400 leading-tight">
                                            <i className="fa-solid fa-triangle-exclamation mr-1"></i> Changing your handle requires re-verification.
                                        </p>
                                    </div>
                                ) : (
                                    <div className="bg-slate-950/40 p-3 rounded-lg border border-slate-700/50 font-mono text-slate-200">
                                        {currentUser.rsiHandle}
                                    </div>
                                )}
                            </div>

                            <div className="pt-4 border-t border-slate-800">
                                <div className="flex justify-between items-center mb-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Display Name</label>
                                    {!isEditingDisplayName && (
                                        <button
                                            onClick={() => { setDisplayNameDraft(currentUser.displayName || ''); setIsEditingDisplayName(true); }}
                                            className="text-sky-300 hover:text-sky-200 text-[10px] font-black uppercase tracking-widest transition-colors"
                                        >
                                            {currentUser.displayName ? 'Change' : 'Customize'}
                                        </button>
                                    )}
                                </div>
                                {isEditingDisplayName ? (
                                    <div className="bg-slate-950/40 p-4 rounded-xl border border-slate-700 space-y-3 animate-fade-in">
                                        <input
                                            type="text"
                                            value={displayNameDraft}
                                            onChange={(e) => setDisplayNameDraft(e.target.value)}
                                            maxLength={32}
                                            placeholder={currentUser.discordName || currentUser.name}
                                            className="w-full bg-slate-900/60 border border-slate-700 rounded-lg p-3 text-white text-sm focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/30 outline-hidden transition-all"
                                            autoFocus
                                            disabled={isSavingDisplayName}
                                        />
                                        <div className="flex gap-2">
                                            <button
                                                onClick={saveDisplayName}
                                                disabled={isSavingDisplayName}
                                                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-sky-600 hover:bg-sky-500 border border-sky-500/40 rounded-lg shadow-lg shadow-sky-900/30 transition disabled:opacity-50"
                                            >
                                                {isSavingDisplayName ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-check"></i> Save</>}
                                            </button>
                                            {currentUser.displayName && (
                                                <button
                                                    onClick={clearDisplayName}
                                                    disabled={isSavingDisplayName}
                                                    className="px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-slate-300 bg-slate-900/60 border border-slate-700 rounded-lg hover:bg-slate-800 hover:text-white transition-colors disabled:opacity-50"
                                                    title={`Revert to Discord name (${currentUser.discordName || 'unknown'})`}
                                                >
                                                    Reset
                                                </button>
                                            )}
                                            <button
                                                onClick={() => { setIsEditingDisplayName(false); setDisplayNameDraft(currentUser.displayName || ''); }}
                                                disabled={isSavingDisplayName}
                                                className="px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white rounded-lg transition-colors disabled:opacity-50"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                        <p className="text-[10px] text-slate-500 leading-tight">
                                            Shown throughout the app instead of your Discord name. Up to 32 characters. Leave blank and Save, or tap Reset, to fall back to Discord.
                                        </p>
                                    </div>
                                ) : (
                                    <div className="bg-slate-950/40 p-3 rounded-lg border border-slate-700/50 flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="text-slate-200 font-bold truncate">{currentUser.name}</p>
                                            {currentUser.displayName ? (
                                                <p className="text-[10px] text-slate-500 mt-0.5">
                                                    Custom override · Discord: <span className="font-mono text-slate-400">{currentUser.discordName || '—'}</span>
                                                </p>
                                            ) : (
                                                <p className="text-[10px] text-slate-500 mt-0.5">From Discord · set a custom name to override</p>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="pt-4 border-t border-slate-800">
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Rank Synchronization</label>
                                <div className="flex flex-col sm:flex-row gap-4 items-start">
                                    <button
                                        onClick={handleSyncRoles}
                                        disabled={isSyncing || syncCooldown}
                                        className={`
                                            flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest transition-all shadow-lg min-w-[160px] border
                                            ${isSyncing ? 'bg-slate-800 text-slate-400 border-slate-700 cursor-wait' :
                                                syncSuccess ? 'bg-green-600 border-green-500/40 text-white shadow-green-900/30' :
                                                    syncCooldown ? 'bg-slate-900/60 text-slate-500 border-slate-700 cursor-not-allowed' :
                                                        'bg-[#5865F2] hover:bg-[#4752c4] text-white border-[#5865F2] shadow-indigo-900/30'}
                                        `}
                                    >
                                        {isSyncing ? <i className="fa-solid fa-spinner animate-spin" /> :
                                            syncSuccess ? <i className="fa-solid fa-check" /> :
                                                syncCooldown ? <i className="fa-solid fa-clock" /> :
                                                    <i className="fa-brands fa-discord" />}
                                        {isSyncing ? 'Syncing...' : syncSuccess ? 'Synced' : syncCooldown ? <span className="font-mono">{cooldownTime >= 60 ? `${Math.floor(cooldownTime / 60)}m ${cooldownTime % 60}s` : `${cooldownTime}s`}</span> : 'Sync Roles'}
                                    </button>
                                    <p className="text-xs text-slate-400 leading-relaxed">
                                        Pull your latest roles from the Discord server to update your Rank and Permissions on the dashboard.
                                    </p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden">
                        <div className="px-5 py-4 border-b border-white/5 bg-white/5 flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-400">
                                    <i className="fa-solid fa-tower-cell text-sm"></i>
                                </div>
                                <h3 className="font-bold text-white text-sm uppercase tracking-wider">Communications Uplink</h3>
                            </div>
                            <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border text-[10px] font-black uppercase tracking-widest ${isPushActive ? 'bg-green-500/10 text-green-300 border-green-500/30' : 'bg-red-500/10 text-red-400 border-red-500/30'}`}>
                                <span className={`h-1.5 w-1.5 rounded-full ${isPushActive ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}></span>
                                {isPushActive ? 'Online' : 'Offline'}
                            </span>
                        </div>

                        <div className="p-5 space-y-4">
                            <p className="text-xs text-slate-400 leading-relaxed bg-slate-950/40 p-3 rounded-lg border border-slate-700/50">
                                Register this device to receive critical mission alerts and EAM broadcasts even when the dashboard is closed.
                            </p>
                            <div className="grid grid-cols-2 gap-3">
                                <button
                                    onClick={runDiagnostics}
                                    disabled={isDiagnosing}
                                    className="flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-sky-600 hover:bg-sky-500 border border-sky-500/40 rounded-lg shadow-lg shadow-sky-900/30 transition disabled:opacity-50"
                                >
                                    {isDiagnosing ? <i className="fa-solid fa-circle-notch animate-spin"></i> : <i className="fa-solid fa-mobile-screen"></i>}
                                    Register Device
                                </button>
                                <button
                                    onClick={handleTestSignal}
                                    disabled={!isPushActive || isDiagnosing}
                                    className="flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-bold uppercase tracking-widest text-slate-300 bg-slate-900/60 border border-slate-700 rounded-lg hover:bg-slate-800 hover:text-white transition-colors disabled:opacity-50"
                                >
                                    <i className="fa-solid fa-satellite-dish"></i>
                                    Test Signal
                                </button>
                            </div>

                            {diagLog.length > 0 && (
                                <div className="bg-black/40 rounded-lg border border-slate-800 p-3 h-32 overflow-y-auto custom-scrollbar font-mono text-[10px]">
                                    {diagLog.map((log) => (
                                        <div key={log.id} className={`mb-1 ${log.text.includes('ERROR') || log.text.includes('Failed') ? 'text-red-400' : log.text.includes('✅') ? 'text-green-400' : 'text-slate-300'}`}>
                                            {log.text}
                                        </div>
                                    ))}
                                    {isDiagnosing && <div className="text-sky-300 animate-pulse">_ Checking protocols...</div>}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="bg-slate-900/60 backdrop-blur-md border border-slate-700/50 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-white/5 bg-white/5 flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-sky-500/10 flex items-center justify-center text-sky-400">
                            <i className="fa-solid fa-clock text-sm"></i>
                        </div>
                        <h3 className="font-bold text-white text-sm uppercase tracking-wider">Time Preferences</h3>
                    </div>
                    <div className="p-5 space-y-6">
                        <p className="text-xs text-slate-400 leading-relaxed bg-slate-950/40 p-3 rounded-lg border border-slate-700/50">
                            Pick the timezone and date format the dashboard should use when showing times to you. Other members keep their own preferences.
                        </p>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Timezone</label>
                                    {tzDraft !== browserTz && (
                                        <button onClick={resetTzToBrowser} className="text-sky-300 hover:text-sky-200 text-[10px] font-black uppercase tracking-widest transition-colors">
                                            Detect from browser
                                        </button>
                                    )}
                                </div>
                                <select
                                    value={tzDraft}
                                    onChange={(e) => setTzDraft(e.target.value)}
                                    disabled={isSavingPrefs}
                                    className="w-full bg-slate-950/40 border border-slate-700 rounded-lg p-3 text-white text-sm focus:border-sky-500/40 focus:ring-1 focus:ring-sky-500/30 outline-hidden transition-all disabled:opacity-50"
                                >
                                    <optgroup label="Common">
                                        {commonTimezones.map(z => (
                                            <option key={`common-${z.value}`} value={z.value}>{z.label}</option>
                                        ))}
                                    </optgroup>
                                    <optgroup label="All zones">
                                        {allTimezones.map(z => (
                                            <option key={`all-${z}`} value={z}>{z}</option>
                                        ))}
                                    </optgroup>
                                </select>
                                <p className="text-[10px] text-slate-500 mt-2 leading-tight">
                                    Browser detected: <span className="font-mono text-slate-400">{browserTz}</span>
                                </p>
                            </div>

                            <div>
                                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 block">Date Format</label>
                                <div className="space-y-2">
                                    {datePresets.map(p => {
                                        const selected = formatDraft === p.key;
                                        const preview = formatUserDateTime(previewIso, { timezone: tzDraft, dateFormat: p.key });
                                        return (
                                            <button
                                                key={p.key}
                                                type="button"
                                                onClick={() => setFormatDraft(p.key)}
                                                disabled={isSavingPrefs}
                                                className={`w-full text-left p-3 rounded-lg border transition-all flex items-center justify-between gap-3 ${selected ? 'bg-sky-500/10 border-sky-500/40 text-white' : 'bg-slate-950/40 border-slate-700 text-slate-300 hover:border-slate-600'} disabled:opacity-50`}
                                            >
                                                <div className="min-w-0">
                                                    <p className="text-xs font-bold truncate">{p.label}</p>
                                                    <p className="text-[10px] text-slate-500 font-mono mt-0.5 truncate">Now: {preview}</p>
                                                </div>
                                                {selected && <i className="fa-solid fa-check text-sky-300 text-sm shrink-0"></i>}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        <div className="flex justify-end pt-2 border-t border-slate-800">
                            <button
                                onClick={savePreferences}
                                disabled={isSavingPrefs}
                                className="flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-sky-600 hover:bg-sky-500 border border-sky-500/40 rounded-lg shadow-lg shadow-sky-900/30 transition disabled:opacity-50"
                            >
                                {isSavingPrefs ? <i className="fa-solid fa-spinner animate-spin"></i> : <><i className="fa-solid fa-check"></i> Save Preferences</>}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="bg-red-950/10 border border-red-500/20 rounded-xl overflow-hidden">
                    <div className="px-5 py-4 border-b border-red-500/10 bg-red-500/5 flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center text-red-400">
                            <i className="fa-solid fa-triangle-exclamation text-sm"></i>
                        </div>
                        <h3 className="font-black text-red-300 text-sm uppercase tracking-widest">Danger Zone</h3>
                    </div>
                    <div className="p-5">
                        <button
                            onClick={openDeleteAccountModal}
                            disabled={currentUser.role === 'Admin'}
                            className="w-full flex items-center justify-center gap-2 px-4 py-3 text-xs font-bold uppercase tracking-widest text-red-300 bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 rounded-lg shadow-lg shadow-red-900/20 transition-colors disabled:bg-slate-900/60 disabled:border-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed disabled:shadow-none"
                        >
                            <i className="fa-solid fa-trash"></i> Delete Account
                        </button>
                        {currentUser.role === 'Admin' && <p className="text-[10px] text-red-400/60 text-center mt-2 italic">Admins cannot delete their own account.</p>}
                    </div>
                </div>
            </div>

            {showHandleConfirm && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center z-100 animate-fade-in p-4">
                    <div className="bg-slate-900/90 backdrop-blur-md border border-amber-500/30 rounded-xl shadow-2xl max-w-md w-full overflow-hidden">
                        <div className="bg-amber-950/30 p-5 border-b border-amber-500/20 flex items-center gap-4">
                            <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center border border-amber-500/30 text-amber-400 shrink-0">
                                <i className="fa-solid fa-shield-halved"></i>
                            </div>
                            <div>
                                <h3 className="text-base font-black text-white uppercase tracking-tight">Confirm Handle Change</h3>
                                <p className="text-amber-300/80 text-[10px] font-mono uppercase tracking-widest mt-0.5">Security Protocol</p>
                            </div>
                        </div>
                        <div className="p-5 space-y-4">
                            <p className="text-slate-300 text-sm">
                                Are you sure you want to change your handle to <strong className="text-white font-mono">{rsiHandle}</strong>?
                            </p>
                            <p className="text-slate-400 text-xs bg-slate-950/60 p-3 rounded-lg border border-slate-700/50 leading-relaxed">
                                You will be logged out of the terminal immediately and must complete the verification process on RobertsSpaceIndustries.com to regain access.
                            </p>
                        </div>
                        <div className="p-4 bg-slate-950/60 border-t border-white/5 flex justify-end gap-3 rounded-b-xl">
                            <button
                                onClick={() => setShowHandleConfirm(false)}
                                className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors"
                            >
                                Abort
                            </button>
                            <button
                                onClick={confirmSave}
                                className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-amber-600 hover:bg-amber-500 border border-amber-500/40 rounded-lg shadow-lg shadow-amber-900/30 transition"
                            >
                                <i className="fa-solid fa-check"></i> Confirm & Verify
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ProfileView;
