
import React, { useState, useEffect } from 'react';
import { useData } from '../../../contexts/DataContext';

import { TabPageHeader } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';

interface HealthCheckResult {
    check: string;
    status: 'OK' | 'WARNING' | 'ERROR';
    count: number;
    action?: string;
}

// Zone heading — groups the tab into Operations / Data Hygiene / Danger Zone.
const ZoneHeader: React.FC<{ icon: string; title: string; subtitle: string; tone?: 'normal' | 'danger' }> = ({ icon, title, subtitle, tone = 'normal' }) => (
    <div className="flex items-start gap-3 pt-2">
        <i className={`fa-solid ${icon} mt-0.5 ${tone === 'danger' ? 'text-red-400' : 'text-slate-400'}`}></i>
        <div>
            <h2 className={`text-xs font-black uppercase tracking-[0.2em] ${tone === 'danger' ? 'text-red-300' : 'text-slate-300'}`}>{title}</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>
        </div>
    </div>
);

const DatabaseToolsTab: React.FC = () => {
    const { rpcAction, orgMeta } = useData();
    const { addToast, confirm } = useNotification();
    const [isLoading, setIsLoading] = useState(false);
    const [healthReport, setHealthReport] = useState<HealthCheckResult[]>([]);

    // Pruning State
    const [retentionDays, setRetentionDays] = useState(90);
    const [selectedTargets, setSelectedTargets] = useState<Set<string>>(() => new Set(['requests']));
    const [pruneResult, setPruneResult] = useState<Record<string, number> | null>(null);

    // Module reset state
    const [resettingModule, setResettingModule] = useState<null | 'finances' | 'quartermaster'>(null);
    const [resetResult, setResetResult] = useState<{ module: string; counts: Record<string, number> } | null>(null);

    // Maintenance mode + force-logout state
    const [maintMode, setMaintMode] = useState(false);
    const [maintMessage, setMaintMessage] = useState('');
    const [maintLoading, setMaintLoading] = useState(false);

    // Danger Zone — full reset / full wipe. Each needs an exact typed phrase to
    // arm the button, then a final confirm dialog.
    const RESET_PHRASE = 'RESET';
    const WIPE_PHRASE = 'WIPE EVERYTHING';
    const [resetPhrase, setResetPhrase] = useState('');
    const [wipePhrase, setWipePhrase] = useState('');
    const [dangerBusy, setDangerBusy] = useState<null | 'reset' | 'wipe'>(null);
    const [wiped, setWiped] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const s = await rpcAction('admin:get_platform_settings', {});
                setMaintMode(!!s?.maintenance_mode);
                setMaintMessage(s?.maintenance_message || '');
            } catch { /* non-fatal — defaults shown */ }
        })();
    }, [rpcAction]);

    const saveMaintenance = async () => {
        setMaintLoading(true);
        try {
            await rpcAction('admin:update_platform_settings', { maintenanceMode: maintMode, maintenanceMessage: maintMessage });
            addToast('Maintenance Settings Saved', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: maintMode ? 'Maintenance mode is ON — non-admin members are blocked.' : 'Maintenance mode is off.' });
        } catch (error) {
            console.error(error);
            addToast('Save Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: 'Could not update maintenance settings.' });
        } finally {
            setMaintLoading(false);
        }
    };

    const forceLogoutAll = async () => {
        const ok = await confirm({ title: 'Force Logout All Sessions', message: 'Force logout ALL active sessions? Everyone must log in again (takes effect within ~60 seconds). This cannot be undone.', confirmText: 'Force Logout', variant: 'danger' });
        if (!ok) return;
        setMaintLoading(true);
        try {
            await rpcAction('admin:force_logout_all', {});
            addToast('Sessions Revoked', <i className="fa-solid fa-power-off"></i>, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { description: 'All existing sessions will be logged out shortly.' });
        } catch (error) {
            console.error(error);
            addToast('Force Logout Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: 'Could not revoke sessions.' });
        } finally {
            setMaintLoading(false);
        }
    };

    const financesEnabled = (orgMeta?.features?.finances?.enabled) === true;
    const quartermasterEnabled = (orgMeta?.features?.quartermaster?.enabled) === true;

    const runDiagnostics = async () => {
        setIsLoading(true);
        setHealthReport([]);
        try {
            const results = await rpcAction('admin:db:check', {});
            setHealthReport(results);
        } catch (error) {
            console.error(error);
            addToast("Diagnostics Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Could not complete the database health check." });
        } finally {
            setIsLoading(false);
        }
    };

    const runRepair = async () => {
        const confirmedRepair = await confirm({ title: 'Confirm Repair', message: 'This re-seeds missing structural data and re-grants the Admin role every permission (the fix for "access denied" on Catalogs after an import). Non-destructive — no records are deleted. Continue?', confirmText: 'Repair', variant: 'danger' });
        if (!confirmedRepair) return;
        setIsLoading(true);
        try {
            const result = await rpcAction('admin:db:repair', {});
            addToast("Repair Complete", <i className="fa-solid fa-check"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: result.message });
            runDiagnostics();
        } catch (error) {
            console.error(error);
            addToast("Repair Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "The database repair operation could not be completed." });
        } finally {
            setIsLoading(false);
        }
    };

    const toggleTarget = (target: string) => {
        setSelectedTargets(prev => {
            const next = new Set(prev);
            if (next.has(target)) next.delete(target);
            else next.add(target);
            return next;
        });
    };

    const runModuleReset = async (module: 'finances' | 'quartermaster') => {
        const labels: Record<string, { name: string; describe: string; action: string }> = {
            finances: {
                name: 'Finances',
                describe: 'EVERY treasury account, ledger entry, deposit, withdrawal, transfer, payout, adjustment, and reversal',
                action: 'admin:db:reset_finances',
            },
            quartermaster: {
                name: 'Quartermaster',
                describe: 'EVERY catalog item (custom only), location, inventory row, movement, and issuance — past and present',
                action: 'admin:db:reset_quartermaster',
            },
        };
        const meta = labels[module];

        const confirmed = await confirm({
            title: `Reset ${meta.name} Data`,
            message: `WARNING: This will PERMANENTLY DELETE ${meta.describe} for this organization. The module configuration (feature flag, permissions) is preserved, but all records will be wiped to a clean slate. This action CANNOT be undone.`,
            confirmText: `Wipe ${meta.name}`,
            variant: 'danger',
        });
        if (!confirmed) return;

        const doubleConfirm = await confirm({
            title: 'Final Confirmation',
            message: `Last chance. All ${meta.name} data will be irreversibly destroyed for this organization. Continue?`,
            confirmText: 'Yes, wipe it',
            variant: 'danger',
        });
        if (!doubleConfirm) return;

        setResettingModule(module);
        setResetResult(null);
        try {
            const result = await rpcAction(meta.action, {});
            setResetResult({ module: meta.name, counts: result || {} });
            addToast(`${meta.name} Reset`, <i className="fa-solid fa-check"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: `${meta.name} data wiped successfully.` });
        } catch (error) {
            console.error(error);
            addToast("Reset Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: `Failed to reset ${meta.name} data.` });
        } finally {
            setResettingModule(null);
        }
    };

    const runFullReset = async () => {
        const confirmed = await confirm({
            title: 'Reset to a Fresh Install',
            message: 'This PERMANENTLY DELETES all members, operations, intel, requests, HR, fleet, government, finances, quartermaster, warehouse, wiki, and alliance data, and reseeds the default roles/ranks/units/locations. ONLY your admin account is kept (you stay signed in). Branding and settings reset to defaults. This CANNOT be undone.',
            confirmText: 'Reset Everything',
            variant: 'danger',
        });
        if (!confirmed) return;
        setDangerBusy('reset');
        try {
            const result = await rpcAction('admin:db:full_reset', { confirmPhrase: resetPhrase.trim() });
            addToast('Organization Reset', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: result?.message || 'Reset complete. Reloading…' });
            setResetPhrase('');
            // Reload so every context re-hydrates against the clean slate.
            setTimeout(() => window.location.assign('/'), 1200);
        } catch (error) {
            console.error(error);
            addToast('Reset Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: error instanceof Error ? error.message : 'Could not reset the organization.' });
            setDangerBusy(null);
        }
    };

    const runFullWipe = async () => {
        const confirmed = await confirm({
            title: 'Wipe Everything',
            message: 'This DESTROYS THE ENTIRE DATABASE — every member (including you), all data, and all settings. You will be logged out, and you must RESTART / REDEPLOY the server to generate a new one-time admin claim code. There is NO way to undo this.',
            confirmText: 'Wipe The Entire Database',
            variant: 'danger',
        });
        if (!confirmed) return;
        setDangerBusy('wipe');
        try {
            await rpcAction('admin:db:full_wipe', { confirmPhrase: wipePhrase.trim() });
            // The admin's account no longer exists — drop the local session and
            // show the redeploy prompt (a reload would hit an empty DB).
            try { localStorage.removeItem('myrsi_auth_token'); localStorage.removeItem('myrsi_user'); } catch { /* ignore */ }
            setWiped(true);
        } catch (error) {
            console.error(error);
            addToast('Wipe Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: error instanceof Error ? error.message : 'Could not wipe the database.' });
            setDangerBusy(null);
        }
    };

    const runPruning = async () => {
        if (selectedTargets.size === 0) {
            addToast("No Targets Selected", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: "Please select at least one data type to prune." });
            return;
        }
        const confirmedPrune = await confirm({ title: 'Confirm Pruning', message: `WARNING: This will PERMANENTLY DELETE data older than ${retentionDays} days for selected categories. This action cannot be undone.`, confirmText: 'Purge', variant: 'danger' });
        if (!confirmedPrune) return;

        setIsLoading(true);
        setPruneResult(null);
        try {
            const result = await rpcAction('admin:db:prune', {
                retentionDays,
                targets: Array.from(selectedTargets)
            });
            setPruneResult(result);
            runDiagnostics();
        } catch (error) {
            console.error(error);
            addToast("Pruning Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "The data pruning operation could not be completed." });
        } finally {
            setIsLoading(false);
        }
    };

    // Post-wipe screen: the DB is empty; nothing else can run.
    if (wiped) {
        return (
            <div className="p-4 md:p-8 flex items-center justify-center min-h-[60vh] animate-fade-in">
                <div className="max-w-xl w-full bg-slate-900/60 border border-red-500/30 rounded-2xl p-8 text-center space-y-4">
                    <div className="w-14 h-14 mx-auto rounded-2xl bg-red-500/10 flex items-center justify-center">
                        <i className="fa-solid fa-radiation text-red-400 text-2xl"></i>
                    </div>
                    <h2 className="text-xl font-black text-white">Database Wiped</h2>
                    <p className="text-sm text-slate-400 leading-relaxed">
                        Every record, member, and setting has been destroyed. There is no admin account left,
                        so the app can&apos;t be used until you reseed it.
                    </p>
                    <div className="text-left text-sm text-slate-300 bg-black/30 border border-slate-700/50 rounded-lg p-4 space-y-2">
                        <p className="font-bold text-white"><i className="fa-solid fa-rotate-right mr-2 text-amber-400"></i>Next step — restart / redeploy the server:</p>
                        <ol className="list-decimal list-inside space-y-1 text-slate-400 text-xs">
                            <li>Restart the app process (or trigger a redeploy in your host, e.g. Coolify).</li>
                            <li>On boot it detects the empty DB and prints a fresh <span className="font-mono text-amber-300">SETUP-XXXX</span> code to the server console / logs.</li>
                            <li>Open the app, sign in with Discord, and redeem that code to claim the new Admin seat.</li>
                        </ol>
                    </div>
                    <p className="text-[11px] text-slate-600">You have been signed out on this device.</p>
                </div>
            </div>
        );
    }

    const dangerLocked = dangerBusy !== null;

    return (
        <div className="p-4 md:p-8 space-y-8 animate-fade-in">
            <TabPageHeader
                title="System Database Tools"
                icon="fa-solid fa-server"
                accent="rose"
                subtitle="Operate the platform, keep the database tidy, and — when you really mean it — reset or wipe the whole instance."
            />

            {/* ===================== ZONE 1 — OPERATIONS ===================== */}
            <ZoneHeader icon="fa-sliders" title="Operations" subtitle="Day-to-day platform controls and integrity checks." />

            {/* Maintenance & Sessions */}
            <div className="bg-slate-900/40 rounded-xl border border-amber-500/30 overflow-hidden">
                <div className="px-6 py-4 bg-amber-500/5 border-b border-amber-500/20">
                    <h3 className="text-sm font-bold text-amber-300 uppercase tracking-wider"><i className="fa-solid fa-wrench mr-2"></i>Maintenance &amp; Sessions</h3>
                </div>
                <div className="p-6 space-y-5">
                    <div>
                        <div className="flex items-center gap-3">
                            <button
                                type="button"
                                onClick={() => setMaintMode(v => !v)}
                                aria-pressed={maintMode}
                                aria-label="Toggle maintenance mode"
                                className={`relative w-12 h-6 rounded-full transition-colors shrink-0 ${maintMode ? 'bg-amber-500' : 'bg-slate-700'}`}
                            >
                                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${maintMode ? 'translate-x-6' : ''}`}></span>
                            </button>
                            <span className="text-sm font-medium text-slate-200">{maintMode ? 'Maintenance Mode Active' : 'Maintenance Mode Disabled'}</span>
                        </div>
                        <p className="text-xs text-slate-500 mt-2">When enabled, non-admin members see a maintenance screen and dashboard data fetches are blocked (503). Admins retain full access.</p>
                    </div>
                    {maintMode && (
                        <div>
                            <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Maintenance Message</label>
                            <textarea
                                className="w-full bg-black/30 border border-amber-500/30 rounded-md p-3 text-white text-sm focus:border-amber-500 focus:outline-hidden h-20"
                                value={maintMessage}
                                onChange={e => setMaintMessage(e.target.value)}
                                placeholder="The dashboard is undergoing scheduled maintenance. Please check back shortly."
                            />
                        </div>
                    )}
                    <button
                        onClick={saveMaintenance}
                        disabled={maintLoading}
                        className="text-xs bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded-md font-bold uppercase transition-colors disabled:opacity-50"
                    >
                        {maintLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Save Maintenance Settings'}
                    </button>

                    <div className="pt-4 border-t border-slate-700/50">
                        <h4 className="text-sm font-bold text-red-400 mb-1"><i className="fa-solid fa-power-off mr-2"></i>Force Logout All Sessions</h4>
                        <p className="text-xs text-slate-500 mb-3">Invalidate every active session — e.g. after rotating secrets or a suspected compromise. Members must log in again within ~60 seconds.</p>
                        <button
                            onClick={forceLogoutAll}
                            disabled={maintLoading}
                            className="text-xs bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-md font-bold uppercase transition-colors disabled:opacity-50"
                        >
                            <i className="fa-solid fa-power-off mr-2"></i>Force Logout All Now
                        </button>
                    </div>
                </div>
            </div>

            {/* Diagnostics Panel */}
            <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden flex flex-col">
                <div className="px-6 py-4 bg-slate-800/50 border-b border-slate-700/50 flex justify-between items-center">
                    <h3 className="text-sm font-bold text-white uppercase tracking-wider">Health &amp; Integrity</h3>
                    <div className="flex gap-2">
                        <button
                            onClick={runRepair}
                            disabled={isLoading}
                            className="text-[10px] bg-amber-600 hover:bg-amber-500 text-white px-3 py-1 rounded-sm font-bold uppercase transition-colors disabled:opacity-50"
                            title="Re-seed structural data and re-grant the Admin role all permissions"
                        >
                            Repair Database
                        </button>
                        <button
                            onClick={runDiagnostics}
                            disabled={isLoading}
                            className="text-[10px] bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white px-3 py-1 rounded-sm font-bold uppercase transition-colors disabled:opacity-50"
                        >
                            {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Run Diagnostics'}
                        </button>
                    </div>
                </div>

                <div className="p-6 flex-1 overflow-y-auto max-h-[400px]">
                    <p className="text-[11px] text-slate-500 mb-4"><i className="fa-solid fa-circle-info mr-1.5"></i>Seeing &quot;access denied&quot; on the Catalogs after an import? Click <span className="text-amber-300 font-semibold">Repair Database</span> — it re-grants the Admin role every permission.</p>
                    {healthReport.length > 0 ? (
                        <div className="space-y-3">
                            {healthReport.map((item) => (
                                <div key={item.check} className="flex items-center justify-between p-3 rounded-sm bg-slate-800/30 border border-slate-700/30">
                                    <div>
                                        <p className="text-sm font-bold text-slate-200">{item.check}</p>
                                        <p className="text-xs text-slate-500">Records: {item.count}</p>
                                    </div>
                                    <div className={`px-2 py-0.5 rounded text-[10px] font-black uppercase border ${item.status === 'OK' ? 'text-green-400 border-green-500/30 bg-green-500/10' :
                                            'text-amber-400 border-amber-500/30 bg-amber-500/10 animate-pulse'
                                        }`}>
                                        {item.status}
                                    </div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="flex flex-col items-center justify-center h-40 text-slate-600">
                            <i className="fa-solid fa-stethoscope text-4xl mb-4 opacity-50"></i>
                            <p className="text-sm font-mono uppercase">Awaiting Diagnosis</p>
                        </div>
                    )}
                </div>
            </div>

            {/* ===================== ZONE 2 — DATA HYGIENE ===================== */}
            <ZoneHeader icon="fa-broom" title="Data Hygiene" subtitle="Trim old records to keep the database lean. Targeted and reversible only by re-entry." />

            {/* Optimization Panel */}
            <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden flex flex-col">
                <div className="px-6 py-4 bg-slate-800/50 border-b border-slate-700/50">
                    <h3 className="text-sm font-bold text-white uppercase tracking-wider">Optimization &amp; Pruning</h3>
                    <p className="text-[10px] text-slate-400 mt-1">Permanently remove old, closed records to reduce database size.</p>
                </div>

                <div className="p-6 space-y-6">
                    <div>
                        <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-4">
                            Retention Period: <span className="text-white text-lg ml-2">{retentionDays} Days</span>
                        </label>
                        <input
                            type="range"
                            min="30"
                            max="365"
                            step="30"
                            value={retentionDays}
                            onChange={(e) => setRetentionDays(parseInt(e.target.value))}
                            className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-slate-400"
                        />
                        <div className="flex justify-between text-[10px] text-slate-500 mt-2 font-mono">
                            <span>30 Days</span>
                            <span>1 Year</span>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <p className="text-xs font-bold text-slate-400 uppercase">Target Tables</p>
                        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            {[
                                { id: 'requests', label: 'Service Requests' },
                                { id: 'warrants', label: 'Closed Caution Notes' },
                                { id: 'intel', label: 'Intel Reports' },
                                { id: 'operations', label: 'Concluded Ops' },
                                { id: 'hr', label: 'Rejected Applications' }
                            ].map(t => (
                                <label key={t.id} className={`flex items-center p-3 rounded-sm border cursor-pointer transition-colors ${selectedTargets.has(t.id) ? 'bg-red-500/10 border-red-500/50' : 'bg-slate-800 border-slate-700 hover:border-slate-600'}`}>
                                    <input
                                        type="checkbox"
                                        checked={selectedTargets.has(t.id)}
                                        onChange={() => toggleTarget(t.id)}
                                        className="form-checkbox h-4 w-4 text-red-600 bg-slate-900 border-slate-600 rounded-sm focus:ring-red-500"
                                    />
                                    <span className={`ml-3 text-xs font-bold ${selectedTargets.has(t.id) ? 'text-red-200' : 'text-slate-400'}`}>{t.label}</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className="pt-4 border-t border-slate-700/50 flex items-center justify-between">
                        {pruneResult && (
                            <div className="text-xs text-green-400">
                                <span className="font-bold">Pruning Complete:</span>
                                <ul className="mt-1 list-disc list-inside opacity-80">
                                    {Object.entries(pruneResult).map(([k, v]) => (
                                        <li key={k}>{v} {k} deleted</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <button
                            onClick={runPruning}
                            disabled={isLoading || selectedTargets.size === 0}
                            className="ml-auto bg-red-600 hover:bg-red-500 text-white font-bold px-6 py-3 rounded-lg shadow-lg shadow-red-900/20 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed uppercase tracking-wider text-xs transition-all active:scale-95"
                        >
                            {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Purge Old Data'}
                        </button>
                    </div>
                </div>
            </div>

            {/* ===================== ZONE 3 — DANGER ZONE ===================== */}
            <ZoneHeader icon="fa-radiation" title="Danger Zone" subtitle="Irreversible. Destroys records wholesale. Read each card before you act." tone="danger" />

            <div className="rounded-xl border-2 border-red-500/40 bg-red-950/10 overflow-hidden">
                <div className="p-6 space-y-6">

                    {/* Module Reset — only if a resettable module is enabled */}
                    {(financesEnabled || quartermasterEnabled) && (
                        <div className="space-y-4">
                            <div>
                                <h3 className="text-sm font-bold text-red-300 uppercase tracking-wider flex items-center">
                                    <i className="fa-solid fa-eraser mr-2"></i>Module Reset
                                </h3>
                                <p className="text-[11px] text-red-200/60 mt-1">Wipe a single optional module&apos;s records to a clean slate. The module stays enabled; only its data is destroyed.</p>
                            </div>

                            {financesEnabled && (
                                <div className="flex items-start justify-between gap-4 p-4 bg-slate-900/50 border border-slate-700/40 rounded-lg">
                                    <div className="flex items-start gap-3 flex-1">
                                        <div className="w-10 h-10 shrink-0 rounded-lg bg-amber-500/10 flex items-center justify-center">
                                            <i className="fa-solid fa-vault text-amber-300"></i>
                                        </div>
                                        <div>
                                            <h4 className="text-sm font-bold text-white">Reset Finances</h4>
                                            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                                Deletes every treasury account and the entire ledger (deposits, withdrawals, transfers, payouts, adjustments, reversals). The audit trail will be gone forever.
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => runModuleReset('finances')}
                                        disabled={resettingModule !== null || dangerLocked}
                                        className="bg-red-600 hover:bg-red-500 text-white font-bold px-5 py-2.5 rounded-lg shadow-lg shadow-red-900/20 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed uppercase tracking-wider text-xs transition-all active:scale-95 whitespace-nowrap"
                                    >
                                        {resettingModule === 'finances' ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Reset Finances'}
                                    </button>
                                </div>
                            )}

                            {quartermasterEnabled && (
                                <div className="flex items-start justify-between gap-4 p-4 bg-slate-900/50 border border-slate-700/40 rounded-lg">
                                    <div className="flex items-start gap-3 flex-1">
                                        <div className="w-10 h-10 shrink-0 rounded-lg bg-orange-500/10 flex items-center justify-center">
                                            <i className="fa-solid fa-warehouse text-orange-400"></i>
                                        </div>
                                        <div>
                                            <h4 className="text-sm font-bold text-white">Reset Quartermaster</h4>
                                            <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                                Deletes every custom catalog item, location, inventory row, movement record, and issuance (active, returned, written off). Platform catalog rows are preserved.
                                            </p>
                                        </div>
                                    </div>
                                    <button
                                        onClick={() => runModuleReset('quartermaster')}
                                        disabled={resettingModule !== null || dangerLocked}
                                        className="bg-red-600 hover:bg-red-500 text-white font-bold px-5 py-2.5 rounded-lg shadow-lg shadow-red-900/20 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed uppercase tracking-wider text-xs transition-all active:scale-95 whitespace-nowrap"
                                    >
                                        {resettingModule === 'quartermaster' ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Reset Quartermaster'}
                                    </button>
                                </div>
                            )}

                            {resetResult && (
                                <div className="text-xs text-green-400 p-3 bg-green-500/5 border border-green-500/20 rounded-sm">
                                    <span className="font-bold">{resetResult.module} Reset Complete:</span>
                                    <ul className="mt-1 list-disc list-inside opacity-80">
                                        {Object.entries(resetResult.counts).map(([k, v]) => (
                                            <li key={k}>{v} {k.replace(/_/g, ' ')} deleted</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Full reset — keep one admin */}
                    <div className="p-5 bg-slate-900/50 border border-red-500/30 rounded-lg space-y-3">
                        <div className="flex items-start gap-3">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-red-500/10 flex items-center justify-center">
                                <i className="fa-solid fa-arrows-rotate text-red-400"></i>
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-white">Reset to a Fresh Install <span className="text-red-300/80">(keep my admin)</span></h4>
                                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                    Wipes <span className="text-red-300">all members and all org data</span> and reseeds the defaults, but keeps <span className="text-white font-semibold">your</span> admin account — you stay signed in. Branding and settings reset to defaults. Use this to start the org over from scratch without redeploying.
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2 sm:items-center pl-1">
                            <input
                                value={resetPhrase}
                                onChange={e => setResetPhrase(e.target.value)}
                                placeholder={`Type "${RESET_PHRASE}" to enable`}
                                disabled={dangerLocked}
                                className="flex-1 bg-black/40 border border-slate-600 rounded-md px-3 py-2 text-white text-sm outline-hidden focus:border-red-500 disabled:opacity-50"
                            />
                            <button
                                onClick={runFullReset}
                                disabled={resetPhrase.trim() !== RESET_PHRASE || dangerLocked}
                                className="bg-red-600 hover:bg-red-500 text-white font-bold px-5 py-2.5 rounded-lg uppercase tracking-wider text-xs transition-all active:scale-95 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed whitespace-nowrap"
                            >
                                {dangerBusy === 'reset' ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Reset to Fresh Install'}
                            </button>
                        </div>
                    </div>

                    {/* Full wipe — nuke everything */}
                    <div className="p-5 bg-black/30 border-2 border-red-600/50 rounded-lg space-y-3">
                        <div className="flex items-start gap-3">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-red-600/20 flex items-center justify-center">
                                <i className="fa-solid fa-skull-crossbones text-red-400"></i>
                            </div>
                            <div>
                                <h4 className="text-sm font-bold text-red-200">Wipe Everything</h4>
                                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                    Destroys the <span className="text-red-300 font-semibold">entire database</span> — every member (including you) and all settings. You will be logged out and must <span className="text-white font-semibold">restart / redeploy</span> the server, which prints a new one-time admin claim code. Total reset to first-boot.
                                </p>
                            </div>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2 sm:items-center pl-1">
                            <input
                                value={wipePhrase}
                                onChange={e => setWipePhrase(e.target.value)}
                                placeholder={`Type "${WIPE_PHRASE}" to enable`}
                                disabled={dangerLocked}
                                className="flex-1 bg-black/40 border border-slate-600 rounded-md px-3 py-2 text-white text-sm outline-hidden focus:border-red-500 disabled:opacity-50"
                            />
                            <button
                                onClick={runFullWipe}
                                disabled={wipePhrase.trim() !== WIPE_PHRASE || dangerLocked}
                                className="bg-red-700 hover:bg-red-600 text-white font-black px-5 py-2.5 rounded-lg uppercase tracking-wider text-xs transition-all active:scale-95 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed whitespace-nowrap"
                            >
                                {dangerBusy === 'wipe' ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Wipe The Database'}
                            </button>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    );
};

export default DatabaseToolsTab;
