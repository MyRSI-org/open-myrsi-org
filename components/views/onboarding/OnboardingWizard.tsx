import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSession } from '../../../contexts/SessionContext';
import apiService from '../../../services/apiService';

// First-run setup wizard for a fresh self-hosted instance. Rendered by
// DashboardApp whenever `setupCompleted` is false. It orchestrates the existing
// auth flow (Discord sign-in → admin claim code → RSI verify) plus first-run
// chrome (welcome, preflight, optional SaaS import, congrats) and reconciles its
// step with auth state so an OAuth round-trip / reload resumes correctly.

const LOGO = '/media/myrsiorg_brand_logo_transparent.png';

type Step = 'welcome' | 'preflight' | 'discord' | 'claim' | 'rsi' | 'import' | 'congrats';
const STEP_ORDER: Step[] = ['welcome', 'preflight', 'discord', 'claim', 'rsi', 'import', 'congrats'];
const STEP_LABELS: Record<Step, string> = {
    welcome: 'Welcome', preflight: 'Preflight', discord: 'Create account',
    claim: 'Admin claim', rsi: 'RSI handle', import: 'Import data', congrats: 'All set',
};

interface PreflightStatus {
    dbConnected: boolean; adminExists: boolean; discordConfigured: boolean;
    realtimeEnabled: boolean; secretsEncrypted: boolean; sessionSecretStrong: boolean;
    setupCompleted: boolean; setupCodeExists: boolean;
}

// `requiresRestart` flags checks that read environment variables. Node snapshots
// process.env at boot, so a newly-set var is invisible to a re-check until the
// app/container restarts — the tips and a "Restart required" badge make that
// explicit. dbConnected is a live DB read where a plain re-check genuinely works.
const CHECKS: { key: keyof PreflightStatus; label: string; critical: boolean; requiresRestart: boolean; tip: string }[] = [
    { key: 'dbConnected', label: 'Database connection', critical: true, requiresRestart: false, tip: 'Could not reach the database. Check your network and Supabase project status, then re-check. (The server will not start at all if it cannot reach Supabase, so this normally only fails on a transient blip.)' },
    { key: 'discordConfigured', label: 'Discord sign-in', critical: true, requiresRestart: true, tip: 'Set DISCORD_CLIENT_ID in your environment, then restart the app/container and re-check — you sign in with Discord in the next step. Environment variables are only read at startup, so a re-check alone will not pick up a new value.' },
    { key: 'sessionSecretStrong', label: 'Session token signing key', critical: false, requiresRestart: true, tip: 'Set JWT_SECRET to a high-entropy random value of at least 32 characters (e.g. `openssl rand -hex 32`), then restart the app/container and re-check (env vars are only read at startup). A short/weak key makes session tokens forgeable.' },
    { key: 'secretsEncrypted', label: 'Secrets encryption at rest', critical: false, requiresRestart: true, tip: 'Set SECRETS_ENCRYPTION_KEY to a random value of at least 32 characters (e.g. `openssl rand -hex 32`) so admin-entered API keys are encrypted at rest, then restart the app/container and re-check (env vars are only read at startup). A short/weak key weakens the encryption. (In production the server refuses to start until this is at least 32 chars.)' },
    { key: 'realtimeEnabled', label: 'Live realtime updates', critical: false, requiresRestart: true, tip: 'Set SUPABASE_JWT_SECRET (your Supabase project JWT secret, ≥32 chars) to enable live updates, then restart the app/container and re-check (env vars are only read at startup). Otherwise the app refreshes manually.' },
];

export default function OnboardingWizard() {
    const { pendingUser, currentUser, handleLogin, redeemAdminSetupCode, handleNewUserSetup } = useSession();

    const deriveStep = useCallback((): Step => {
        if (currentUser) return 'import';
        if (pendingUser) return pendingUser.adminSetupToken ? 'rsi' : 'claim';
        return 'welcome';
    }, [currentUser, pendingUser]);

    const [step, setStep] = useState<Step>(deriveStep);

    // Advance forward only when auth state implies a later step (OAuth return → claim;
    // finalize → import). Never moves backwards (e.g. while on import/congrats).
    // Implemented with React's "adjust state during render" pattern + a previous-value
    // tracker on the auth-derived target step: when that target changes (OAuth
    // round-trip / reload) we ratchet `step` forward, never to an equal-or-earlier
    // step. Runs during render (before paint), so it is equivalent to the old
    // reconcile-in-effect and cannot loop (the ratchet only ever advances).
    const wantStep: Step | null = currentUser ? 'import' : pendingUser ? (pendingUser.adminSetupToken ? 'rsi' : 'claim') : null;
    const [prevWantStep, setPrevWantStep] = useState(wantStep);
    if (wantStep !== prevWantStep) {
        setPrevWantStep(wantStep);
        if (wantStep && STEP_ORDER.indexOf(wantStep) > STEP_ORDER.indexOf(step)) {
            setStep(wantStep);
        }
    }

    const go = (s: Step) => setStep(s);
    const activeIdx = STEP_ORDER.indexOf(step);

    return (
        <div className="min-h-screen bg-slate-950 text-slate-200 font-sans flex items-stretch">
            {/* Left rail — branded step list (Windows-setup style) */}
            <aside className="hidden md:flex flex-col w-72 shrink-0 bg-slate-900/60 border-r border-white/5 px-6 py-8">
                <div className="flex items-center gap-3 mb-10">
                    <img src={LOGO} alt="Open MyRSI.org" className="w-10 h-10 object-contain" />
                    <div>
                        <div className="text-sm font-black tracking-tight text-white leading-tight">Open MyRSI.org</div>
                        <div className="text-[11px] text-slate-500">First-run setup</div>
                    </div>
                </div>
                <ol className="space-y-1">
                    {STEP_ORDER.map((s, i) => {
                        const done = i < activeIdx;
                        const active = i === activeIdx;
                        return (
                            <li key={s} className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm ${active ? 'bg-sky-500/10 text-sky-300' : done ? 'text-slate-400' : 'text-slate-600'}`}>
                                <span className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center text-[11px] font-bold ${active ? 'bg-sky-500 text-white' : done ? 'bg-emerald-500/80 text-white' : 'bg-white/5 text-slate-500'}`}>
                                    {done ? <i className="fa-solid fa-check text-[9px]" /> : i + 1}
                                </span>
                                {STEP_LABELS[s]}
                            </li>
                        );
                    })}
                </ol>
                <div className="mt-auto pt-8 text-[11px] text-slate-600">Self-hosted Star Citizen org operations.</div>
            </aside>

            {/* Right pane — active step */}
            <main className="flex-1 flex items-center justify-center px-6 py-10">
                <div className="w-full max-w-xl">
                    {step === 'welcome' && <WelcomeStep onNext={() => go('preflight')} />}
                    {step === 'preflight' && <PreflightStep onNext={() => go('discord')} />}
                    {step === 'discord' && <DiscordStep onSignIn={handleLogin} />}
                    {step === 'claim' && <ClaimStep redeem={redeemAdminSetupCode} pendingName={pendingUser?.name} />}
                    {step === 'rsi' && <RsiStep finalize={handleNewUserSetup} />}
                    {step === 'import' && <ImportStep onContinue={() => go('congrats')} selfDiscordId={currentUser?.discordId} />}
                    {step === 'congrats' && <CongratsStep name={currentUser?.name} />}
                </div>
            </main>
        </div>
    );
}

// Step shell
function Shell({ icon, title, subtitle, children }: { icon: string; title: string; subtitle?: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="flex md:hidden items-center gap-3 mb-6">
                <img src={LOGO} alt="" className="w-9 h-9 object-contain" />
                <span className="text-sm font-black text-white">Open MyRSI.org</span>
            </div>
            <div className="mb-6">
                <div className="w-12 h-12 rounded-xl bg-sky-500/10 text-sky-400 flex items-center justify-center mb-4">
                    <i className={`fa-solid ${icon} text-xl`} />
                </div>
                <h1 className="text-2xl md:text-3xl font-black text-white tracking-tight">{title}</h1>
                {subtitle && <p className="text-slate-400 mt-2 leading-relaxed">{subtitle}</p>}
            </div>
            {children}
        </div>
    );
}

function PrimaryBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
    return (
        <button onClick={onClick} disabled={disabled}
            className="px-6 py-3 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg font-bold shadow-lg shadow-sky-500/20 transition-all">
            {children}
        </button>
    );
}

// Welcome step
function WelcomeStep({ onNext }: { onNext: () => void }) {
    return (
        <Shell icon="fa-rocket" title="Welcome to Open MyRSI.org">
            <p className="text-slate-400 leading-relaxed mb-4">
                This is your own self-hosted operations platform for a single Star Citizen
                organisation. Manage personnel & HR, requests & dispatch, operations, intel, fleet,
                warehouse, quartermaster, government/finance, a wiki, and in-app voice. One
                deployment, one org, your data.
            </p>
            <div className="rounded-xl border border-white/5 bg-slate-900/50 p-4 mb-8">
                <p className="text-slate-300 leading-relaxed text-sm">
                    Thanks for giving Open MyRSI.org a spin. It means a lot that you'd self-host
                    something I built. Let's get you set up; it only takes a minute. o7
                </p>
                <p className="text-slate-500 text-xs mt-2">— Jenk0</p>
            </div>
            <PrimaryBtn onClick={onNext}>Let's go <i className="fa-solid fa-arrow-right ml-1" /></PrimaryBtn>
        </Shell>
    );
}

// Preflight step
function PreflightStep({ onNext }: { onNext: () => void }) {
    const [status, setStatus] = useState<PreflightStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const check = useCallback(async () => {
        setLoading(true); setError('');
        try { setStatus((await apiService.preflight()) || null); }
        catch (e) { setError(e instanceof Error ? e.message : 'Preflight failed'); }
        finally { setLoading(false); }
    }, []);

    // Fetch on mount. `loading` already initialises to true and `error` to '',
    // so the effect performs ONLY the async fetch (no synchronous pre-fetch
    // setState) — its setStatus/setError/setLoading(false) all run after the
    // await, off the synchronous render path. Behaviourally identical to the old
    // `void check()` on mount (whose leading setLoading(true)/setError('') were
    // no-ops against the initial state). The "Re-check" button still calls
    // check(), which does the synchronous reset in an event handler.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const result = (await apiService.preflight()) || null;
                if (!cancelled) setStatus(result);
            } catch (e) {
                if (!cancelled) setError(e instanceof Error ? e.message : 'Preflight failed');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const criticalOk = !!status && CHECKS.filter(c => c.critical).every(c => status[c.key]);
    const anyRestartNeeded = !!status && CHECKS.some(c => !status[c.key] && c.requiresRestart);

    return (
        <Shell icon="fa-clipboard-check" title="Preflight check" subtitle="A quick look at your environment. We never expose any values — just whether each piece is configured.">
            <div className="space-y-2 mb-6">
                {loading && <p className="text-slate-500 text-sm"><i className="fa-solid fa-spinner fa-spin mr-2" />Checking…</p>}
                {error && <p className="text-rose-400 text-sm">{error}</p>}
                {!loading && status && CHECKS.map((c) => {
                    const ok = status[c.key];
                    const tone = ok ? 'text-emerald-400' : c.critical ? 'text-rose-400' : 'text-amber-400';
                    const ico = ok ? 'fa-circle-check' : c.critical ? 'fa-circle-xmark' : 'fa-triangle-exclamation';
                    return (
                        <div key={c.key} className="rounded-lg border border-white/5 bg-slate-900/50 px-4 py-3">
                            <div className="flex items-center gap-3">
                                <i className={`fa-solid ${ico} ${tone}`} />
                                <span className="text-slate-200 text-sm font-medium">{c.label}</span>
                                <span className="ml-auto flex items-center gap-2">
                                    {!ok && c.requiresRestart && (
                                        <span className="text-[10px] uppercase tracking-widest text-amber-500/80"><i className="fa-solid fa-rotate-right mr-1" />Restart required</span>
                                    )}
                                    {!c.critical && <span className="text-[10px] uppercase tracking-widest text-slate-600">Optional</span>}
                                </span>
                            </div>
                            {!ok && <p className="text-xs text-slate-500 mt-2 pl-7">{c.tip}</p>}
                        </div>
                    );
                })}
            </div>
            {!loading && status && !criticalOk && (
                <p className="text-rose-400/90 text-sm mb-4"><i className="fa-solid fa-circle-exclamation mr-2" />Resolve the required items above to continue.</p>
            )}
            {!loading && status && anyRestartNeeded && (
                <p className="text-amber-400/80 text-xs mb-4"><i className="fa-solid fa-circle-info mr-2" />Items marked “Restart required” read environment variables, which are only loaded at startup. Set them, then restart the app/container — re-checking without a restart won't detect the change.</p>
            )}
            <div className="flex items-center gap-3">
                <PrimaryBtn onClick={onNext} disabled={!criticalOk}>Continue <i className="fa-solid fa-arrow-right ml-1" /></PrimaryBtn>
                <button onClick={check} className="px-4 py-3 text-slate-400 hover:text-white text-sm font-medium"><i className="fa-solid fa-rotate mr-2" />Re-check</button>
            </div>
        </Shell>
    );
}

// Create account (Discord) step
function DiscordStep({ onSignIn }: { onSignIn: () => void }) {
    return (
        <Shell icon="fa-discord" title="Create your account" subtitle="Open MyRSI.org uses Discord to sign in. You'll be the organization's first member and Admin.">
            <button onClick={onSignIn}
                className="w-full px-6 py-4 bg-[#5865F2] hover:bg-[#4752c4] text-white rounded-lg font-bold shadow-lg shadow-indigo-500/20 transition-all flex items-center justify-center gap-3">
                <i className="fa-brands fa-discord text-xl" /> Sign in with Discord
            </button>
            <p className="text-xs text-slate-500 mt-4">You'll be redirected to Discord and brought right back here to continue setup.</p>
        </Shell>
    );
}

// Admin claim code step
function ClaimStep({ redeem, pendingName }: { redeem: (code: string) => Promise<string>; pendingName?: string }) {
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const submit = async () => {
        const c = code.trim();
        if (!c) return;
        setBusy(true); setError('');
        try { await redeem(c); /* pendingUser gains adminSetupToken → wizard advances to RSI */ }
        catch (e) { setError(e instanceof Error ? e.message : 'Invalid setup code'); setBusy(false); }
    };

    return (
        <Shell icon="fa-key" title={pendingName ? `Welcome, ${pendingName}` : 'Claim the Admin seat'}
            subtitle="Your account is created. Now claim the Admin seat with the one-time code printed to your server console on first boot.">
            <div className="rounded-lg border border-white/5 bg-slate-900/50 p-4 mb-5 text-xs text-slate-400">
                <i className="fa-solid fa-terminal mr-2 text-slate-500" />
                Look for the <span className="text-sky-300 font-mono">OPEN MYRSI.ORG</span> banner in your server logs — your code looks like <span className="font-mono text-slate-300">SETUP-XXXXXXXX</span>.
            </div>
            <input value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="SETUP-XXXXXXXX" autoFocus
                className="w-full px-4 py-3 bg-slate-900 border border-white/10 rounded-lg text-white font-mono tracking-wider placeholder-slate-600 focus:border-sky-500 focus:outline-none mb-3" />
            {error && <p className="text-rose-400 text-sm mb-3">{error}</p>}
            <PrimaryBtn onClick={submit} disabled={busy || !code.trim()}>{busy ? 'Verifying…' : 'Claim Admin'}</PrimaryBtn>
        </Shell>
    );
}

// RSI handle verification step (with offline bypass)
function genCode() { return `MYRSI-${Math.random().toString(36).substring(2, 8).toUpperCase()}`; }

function RsiStep({ finalize }: { finalize: (rsiHandle: string, verificationCode?: string, skipVerification?: boolean) => Promise<void> }) {
    const [phase, setPhase] = useState<'input' | 'verify'>('input');
    const [handle, setHandle] = useState('');
    const [code] = useState(genCode);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const doFinalize = async (skip: boolean) => {
        setBusy(true); setError('');
        try { await finalize(handle.trim(), skip ? undefined : code, skip); /* currentUser set → wizard advances to import */ }
        catch (e) { setError(e instanceof Error ? e.message : 'Verification failed'); setBusy(false); }
    };

    if (phase === 'input') {
        return (
            <Shell icon="fa-id-badge" title="Link your RSI handle" subtitle="Tell us your Star Citizen (RSI) handle so the org can recognise you.">
                <input value={handle} onChange={(e) => setHandle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handle.trim() && setPhase('verify')}
                    placeholder="Your RSI handle" autoFocus
                    className="w-full px-4 py-3 bg-slate-900 border border-white/10 rounded-lg text-white placeholder-slate-600 focus:border-sky-500 focus:outline-none mb-4" />
                <PrimaryBtn onClick={() => setPhase('verify')} disabled={!handle.trim()}>Next <i className="fa-solid fa-arrow-right ml-1" /></PrimaryBtn>
            </Shell>
        );
    }

    return (
        <Shell icon="fa-id-badge" title="Verify your handle" subtitle={`Confirm you own "${handle.trim()}" by adding this code to your RSI bio.`}>
            <ol className="space-y-3 mb-5 text-sm text-slate-300">
                <li><span className="text-slate-500 mr-2 font-mono">01</span>Open your RSI profile → <span className="text-slate-400">Edit Profile → Short Bio</span>.</li>
                <li><span className="text-slate-500 mr-2 font-mono">02</span>Paste this code anywhere in your bio and save:
                    <div className="mt-2 flex items-center gap-2">
                        <code className="px-3 py-2 bg-slate-900 border border-sky-500/30 rounded text-sky-300 font-mono">{code}</code>
                        <button onClick={() => navigator.clipboard?.writeText(code)} className="text-slate-400 hover:text-white text-xs"><i className="fa-solid fa-copy mr-1" />Copy</button>
                    </div>
                </li>
                <li><span className="text-slate-500 mr-2 font-mono">03</span>Come back and verify.</li>
            </ol>
            {error && <p className="text-rose-400 text-sm mb-3">{error}</p>}
            <div className="flex flex-wrap items-center gap-3">
                <PrimaryBtn onClick={() => doFinalize(false)} disabled={busy}>{busy ? 'Verifying…' : 'Verify & finish'}</PrimaryBtn>
                <button onClick={() => doFinalize(true)} disabled={busy}
                    className="px-4 py-3 text-slate-400 hover:text-white text-sm font-medium">
                    Verify later — I'm offline
                </button>
            </div>
            <p className="text-xs text-slate-600 mt-3">"Verify later" saves your handle as unverified; you can verify any time from your profile.</p>
        </Shell>
    );
}

// Import step (optional, streamed)
interface ImportUserOption { id: number; label: string; sub?: string; discordId?: string }
// Parse the export's `users` rows client-side for the "which of these is you?"
// merge picker. The file is already in the browser, so no extra round-trip.
function parseImportUsers(ndjson: string): ImportUserOption[] {
    const out: ImportUserOption[] = [];
    for (const line of ndjson.split(/\r?\n/)) {
        const t = line.trim(); if (!t) continue;
        let obj: any; try { obj = JSON.parse(t); } catch { continue; }
        if (obj?.kind === 'row' && obj.t === 'users' && obj.r && obj.r.id != null) {
            const r = obj.r;
            const alt = r.display_name || r.name;
            out.push({
                id: Number(r.id),
                label: String(r.rsi_handle || alt || `User #${r.id}`),
                sub: r.rsi_handle && alt ? String(alt) : undefined,
                discordId: r.discord_id != null ? String(r.discord_id) : undefined,
            });
        }
    }
    return out;
}

function ImportStep({ onContinue, selfDiscordId }: { onContinue: () => void; selfDiscordId?: string }) {
    const [ndjson, setNdjson] = useState('');
    const [filename, setFilename] = useState('');
    const [manifest, setManifest] = useState<{ rows: number; tables: number; org?: string } | null>(null);
    const [parseError, setParseError] = useState('');
    const [running, setRunning] = useState(false);
    const [pct, setPct] = useState(0);
    const [logLines, setLogLines] = useState<{ id: number; text: string }[]>([]);
    const [done, setDone] = useState(false);
    const [error, setError] = useState('');
    const [users, setUsers] = useState<ImportUserOption[]>([]);
    const [mergeUserId, setMergeUserId] = useState<number | null>(null);
    const logRef = useRef<HTMLDivElement>(null);
    // Monotonic id source for log lines so each entry has a stable, unique key
    // (the text is non-unique and the array index is unstable across resets).
    const logIdRef = useRef(0);

    const pushLog = (line: string) => setLogLines((l) => [...l, { id: logIdRef.current++, text: line }]);
    useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [logLines]);

    const onFile = (file: File) => {
        setParseError(''); setManifest(null); setDone(false); setError(''); setLogLines([]); setPct(0);
        setFilename(file.name);
        const reader = new FileReader();
        reader.onload = () => {
            const text = String(reader.result || '');
            setNdjson(text);
            try {
                const firstLine = text.split('\n').find((l) => l.trim());
                const header = firstLine ? JSON.parse(firstLine) : null;
                if (!header || header.kind !== 'header' || !header.manifest) { setParseError('This does not look like a myRSI export (.ndjson).'); return; }
                const rows = Object.values(header.manifest as Record<string, number>).reduce((a, b) => a + (b || 0), 0);
                const tables = Object.values(header.manifest as Record<string, number>).filter((n) => (n || 0) > 0).length;
                setManifest({ rows, tables, org: header.sourceOrg?.name });
                const us = parseImportUsers(text);
                setUsers(us);
                const mine = us.find((u) => u.discordId && u.discordId === selfDiscordId);
                setMergeUserId(mine ? mine.id : null);
            } catch { setParseError('Could not read the export header.'); }
        };
        reader.readAsText(file);
    };

    const runImport = async () => {
        setRunning(true); setError(''); setDone(false); setPct(0); setLogLines([]);
        try {
            await apiService.importOrgStream(ndjson, (evt: any) => {
                if (evt.type === 'start') pushLog(`Importing ${evt.totalRows.toLocaleString()} rows across ${evt.totalTables} tables…`);
                else if (evt.type === 'phase') pushLog(`• ${evt.phase}…`);
                else if (evt.type === 'table') {
                    pushLog(`✓ ${evt.table} (${evt.inserted.toLocaleString()})`);
                    if (evt.totalRows > 0) setPct(Math.min(100, Math.round((evt.rowsInserted / evt.totalRows) * 100)));
                }
                else if (evt.type === 'warning') pushLog(`⚠ ${evt.message}`);
                else if (evt.type === 'done') {
                    setPct(100); setDone(true);
                    pushLog(`Done — ${evt.result.rowsInserted.toLocaleString()} rows, ${evt.result.tablesProcessed} tables.`);
                }
                else if (evt.type === 'error') { setError(evt.message); pushLog(`✗ ${evt.message}`); }
            }, mergeUserId ?? undefined);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Import failed');
        } finally {
            setRunning(false);
        }
    };

    return (
        <Shell icon="fa-file-import" title="Import from MyRSI.org (optional)"
            subtitle="Migrating from the hosted platform? Import your org export now, or skip and do it later from Admin → Import.">
            {!running && !done && (
                <div className="rounded-lg border border-dashed border-white/15 bg-slate-900/40 p-5 mb-4 text-center">
                    <input id="import-file" type="file" accept=".ndjson,.jsonl,.json,text/plain" className="hidden"
                        onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
                    <label htmlFor="import-file" className="cursor-pointer inline-flex flex-col items-center gap-2 text-slate-400 hover:text-white">
                        <i className="fa-solid fa-cloud-arrow-up text-3xl text-slate-500" />
                        <span className="text-sm">{filename || 'Choose your export file (.ndjson)'}</span>
                    </label>
                    <p className="text-[11px] text-slate-600 mt-3">Export from <span className="text-slate-400">manage.myrsi.org → Manage org → Export</span>.</p>
                </div>
            )}
            {parseError && <p className="text-rose-400 text-sm mb-3">{parseError}</p>}
            {manifest && !running && !done && (
                <div className="rounded-lg border border-white/5 bg-slate-900/50 px-4 py-3 mb-4 text-xs text-slate-300">
                    <div>Source org: <span className="text-white">{manifest.org || '—'}</span></div>
                    <div>{manifest.rows.toLocaleString()} rows across {manifest.tables} tables</div>
                    <p className="text-slate-500 mt-1">Only standalone-safe data is imported; billing/cross-org/secret tables are excluded automatically.</p>
                </div>
            )}
            {manifest && users.length > 0 && !running && !done && (
                <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-4 py-3 mb-4">
                    <label className="block text-xs font-semibold text-sky-300 mb-1">Which of these is you?</label>
                    <p className="text-[11px] text-slate-500 mb-2">Your admin account was just created, so we merge it with your existing member record — you keep your Discord login and stay Admin, and you're not duplicated.</p>
                    <select
                        value={mergeUserId ?? ''}
                        onChange={(e) => setMergeUserId(e.target.value ? Number(e.target.value) : null)}
                        className="w-full bg-slate-900 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-200"
                    >
                        <option value="">— Select your member —</option>
                        {users.map((u) => (
                            <option key={u.id} value={u.id}>{u.label}{u.sub ? ` · ${u.sub}` : ''}</option>
                        ))}
                    </select>
                    {mergeUserId == null && <p className="text-[11px] text-amber-400/80 mt-2">Pick your member to continue — the import needs to know which account is yours.</p>}
                </div>
            )}
            {(running || done || logLines.length > 0) && (
                <div className="mb-4">
                    <div className="h-2 bg-white/5 rounded-full overflow-hidden mb-2">
                        <div className={`h-full ${error ? 'bg-rose-500' : done ? 'bg-emerald-500' : 'bg-sky-500'} transition-all duration-300`} style={{ width: `${pct}%` }} />
                    </div>
                    <div ref={logRef} className="h-40 overflow-y-auto rounded-lg border border-white/5 bg-slate-950 p-3 font-mono text-[11px] text-slate-400 space-y-0.5">
                        {logLines.map((l) => <div key={l.id} className={l.text.startsWith('⚠') ? 'text-amber-400' : l.text.startsWith('✗') ? 'text-rose-400' : ''}>{l.text}</div>)}
                    </div>
                </div>
            )}
            {error && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 mb-4">
                    <p className="text-rose-300 font-semibold text-sm mb-1"><i className="fa-solid fa-circle-exclamation mr-2" />Import failed</p>
                    <p className="text-rose-200/90 text-xs break-words">{error}</p>
                    <p className="text-slate-400 text-xs mt-2 leading-relaxed">
                        The import did not finish, so this instance may now hold partial data — it is not safe to continue or skip.
                        Reset the database (run <span className="font-mono text-slate-300">reset_db.sql</span> then{' '}
                        <span className="font-mono text-slate-300">schema.sql</span> in Supabase, or recreate the project), restart the app,
                        and run setup again for a clean import.
                    </p>
                </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
                {/* A failed import leaves the instance in an incomplete state (seeded defaults
                    were cleared before the failed insert), so we must NOT let the user continue
                    or skip past it — only reset + restart is safe. */}
                {!done && !error && <PrimaryBtn onClick={runImport} disabled={running || !ndjson || !!parseError || (users.length > 0 && mergeUserId == null)}>{running ? 'Importing…' : 'Import data'}</PrimaryBtn>}
                {done && <PrimaryBtn onClick={onContinue}>Continue <i className="fa-solid fa-arrow-right ml-1" /></PrimaryBtn>}
                {!running && !done && !error && <button onClick={onContinue} className="px-4 py-3 text-slate-400 hover:text-white text-sm font-medium">Skip — I'll do this later</button>}
                {error && <button onClick={() => window.location.assign('/')} className="px-4 py-3 text-slate-400 hover:text-white text-sm font-medium"><i className="fa-solid fa-rotate-left mr-2" />Reload</button>}
            </div>
        </Shell>
    );
}

// Congrats step
function CongratsStep({ name }: { name?: string }) {
    const [busy, setBusy] = useState(false);
    const finish = async () => {
        setBusy(true);
        try {
            await apiService.completeSetup();
            // Full reload into the dashboard: re-runs SSR with __SETUP_COMPLETED__=true
            // so the service worker (intentionally skipped during onboarding) registers,
            // and boots a clean authenticated session as a normal set-up org.
            window.location.assign('/');
        } catch { setBusy(false); }
    };
    return (
        <Shell icon="fa-circle-check" title={name ? `You're all set, ${name}!` : "You're all set!"}
            subtitle="Your organization is ready. Welcome aboard — and thanks again for self-hosting Open MyRSI.org.">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4 mb-8 text-sm text-slate-300">
                Everything else — branding, Discord integration, roles, units, ranks and more — is
                configurable from the <span className="text-emerald-300 font-medium">Admin console</span> inside your dashboard.
            </div>
            <PrimaryBtn onClick={finish} disabled={busy}>{busy ? 'Finishing…' : 'Enter your dashboard'} <i className="fa-solid fa-arrow-right ml-1" /></PrimaryBtn>
        </Shell>
    );
}
