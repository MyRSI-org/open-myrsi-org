
import React, { useState, useRef, useMemo } from 'react';
import { useNotification } from '../../../contexts/NotificationContext';
import { TabPageHeader } from '../../shared/ui';
import apiService from '../../../services/apiService';
import { useSession } from '../../../contexts/SessionContext';

interface ImportHeaderPreview {
    version: number;
    exportedAt?: string;
    sourceApp?: string;
    sourceOrg?: { name?: string; slug?: string };
    tableOrder: string[];
    manifest: Record<string, number>;
}

interface ImportResult {
    tablesProcessed: number;
    rowsInserted: number;
    rowsSkipped: number;
    sequencesReset: string[];
    warnings: string[];
}

interface ImportUserOption { id: number; label: string; sub?: string; discordId?: string }
// Parse the export's `users` rows client-side for the merge picker (the file is
// already in the browser). Mirrors the onboarding wizard's import step.
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

const OrgImportTab: React.FC = () => {
    const { addToast, confirm } = useNotification();
    const { currentUser } = useSession();

    const [ndjson, setNdjson] = useState<string>('');
    const [filename, setFilename] = useState<string>('');
    const [header, setHeader] = useState<ImportHeaderPreview | null>(null);
    const [parseError, setParseError] = useState<string>('');
    const [isImporting, setIsImporting] = useState(false);
    const [result, setResult] = useState<ImportResult | null>(null);
    const [users, setUsers] = useState<ImportUserOption[]>([]);
    const [mergeUserId, setMergeUserId] = useState<number | null>(null);
    const [pct, setPct] = useState(0);
    // Append-only progress log. Each line gets a stable client-only id minted on append
    // (lines are never reordered/removed and can repeat), so we never key on the array index.
    // The id is display-only and is never part of any request payload.
    const [logLines, setLogLines] = useState<{ id: number; text: string }[]>([]);
    const logIdRef = useRef(0);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Light client-side sniff: read ONLY the first line for the header preview.
    // The server re-parses and is authoritative.
    const sniffHeader = (text: string): ImportHeaderPreview | string => {
        const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0);
        if (!firstLine) return 'File is empty.';
        let obj: { kind?: unknown; version?: unknown; tableOrder?: unknown; manifest?: unknown } & Record<string, unknown>;
        try { obj = JSON.parse(firstLine.trim()); }
        catch { return 'First line is not valid JSON — is this a myrsi.org organization export (.ndjson)?'; }
        if (obj.kind !== 'header') return 'First line is not an export header.';
        if (obj.version !== 1) return `Unsupported export version ${String(obj.version)} (this instance imports version 1).`;
        if (!Array.isArray(obj.tableOrder) || !obj.manifest) return 'Export header is missing tableOrder/manifest.';
        return obj as unknown as ImportHeaderPreview;
    };

    const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        setParseError(''); setHeader(null); setResult(null); setNdjson('');
        const reader = new FileReader();
        reader.onload = () => {
            const text = String(reader.result || '');
            const sniffed = sniffHeader(text);
            if (typeof sniffed === 'string') { setParseError(sniffed); return; }
            setNdjson(text);
            setHeader(sniffed);
            setFilename(file.name);
            const us = parseImportUsers(text);
            setUsers(us);
            const mine = us.find((u) => u.discordId && u.discordId === currentUser?.discordId);
            setMergeUserId(mine ? mine.id : null);
        };
        reader.onerror = () => setParseError('Could not read file.');
        reader.readAsText(file);
    };

    const totalRows = header ? Object.values(header.manifest).reduce((a, b) => a + b, 0) : 0;
    const nonEmptyTables = header
        ? header.tableOrder.filter((t) => (header.manifest[t] || 0) > 0)
        : [];

    // Server-provided warnings are display-only and set once per import; mint a stable
    // client-only id per row (recomputed only when `result` changes) so the list isn't keyed
    // by array index. These ids never touch the wire shape — `result.warnings` is untouched.
    const warningRows = useMemo(
        () => (result ? result.warnings.slice(0, 50).map((text) => ({ id: crypto.randomUUID(), text })) : []),
        [result],
    );

    const handleImport = async () => {
        if (!ndjson || !header) return;
        const confirmed = await confirm({
            title: 'Confirm Organization Import',
            message:
                `Import ${totalRows.toLocaleString()} rows across ${nonEmptyTables.length} tables from ` +
                `"${header.sourceOrg?.name || 'unknown source'}". This is a ONE-TIME bootstrap and will be ` +
                `REFUSED if this instance already contains data. Members re-link to their accounts on first ` +
                `Discord login. Continue?`,
            confirmText: 'Run Import',
            variant: 'danger',
        });
        if (!confirmed) return;

        setIsImporting(true); setResult(null); setPct(0); setLogLines([]);
        const pushLog = (line: string) => setLogLines((l) => [...l, { id: logIdRef.current++, text: line }]);
        try {
            await apiService.importOrgStream(ndjson, (evt: any) => {
                if (evt.type === 'start') pushLog(`Importing ${evt.totalRows.toLocaleString()} rows across ${evt.totalTables} tables…`);
                else if (evt.type === 'phase') pushLog(`• ${evt.phase}…`);
                else if (evt.type === 'table') {
                    pushLog(`✓ ${evt.table} (${evt.inserted.toLocaleString()})`);
                    if (evt.totalRows > 0) setPct(Math.min(100, Math.round((evt.rowsInserted / evt.totalRows) * 100)));
                } else if (evt.type === 'warning') pushLog(`⚠ ${evt.message}`);
                else if (evt.type === 'done') {
                    setPct(100); setResult(evt.result as ImportResult);
                    addToast('Import complete', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50',
                        { description: `Inserted ${evt.result.rowsInserted.toLocaleString()} rows. Reload to see imported data.` });
                } else if (evt.type === 'error') {
                    pushLog(`✗ ${evt.message}`);
                    addToast('Import failed', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: evt.message });
                }
            }, mergeUserId ?? undefined);
        } catch (err) {
            addToast('Import failed', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50',
                { description: (err as Error)?.message || 'Could not import organization data.' });
        } finally {
            setIsImporting(false);
        }
    };

    const clear = () => { setNdjson(''); setFilename(''); setHeader(null); setParseError(''); setResult(null); setUsers([]); setMergeUserId(null); };

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Import Organization Data"
                icon="fa-solid fa-database"
                accent="amber"
                subtitle="Bootstrap this self-hosted instance from a full-organization export (.ndjson) downloaded from the hosted myrsi.org customer portal. One-time only — refused if this instance already has data."
            />

            <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden">
                <div className="px-6 py-4 bg-slate-800/50 border-b border-slate-700/50 flex justify-between items-center">
                    <h3 className="text-sm font-bold text-white uppercase tracking-wider">Export File</h3>
                    <input ref={fileInputRef} type="file" accept=".ndjson,.jsonl,.json,text/plain" className="hidden" onChange={handleFileSelected} />
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={isImporting}
                        className="text-[10px] bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white px-3 py-1 rounded-sm font-bold uppercase transition-colors disabled:opacity-50"
                    >
                        <i className="fa-solid fa-folder-open mr-1"></i>Choose File
                    </button>
                </div>

                <div className="p-6 space-y-4">
                    {parseError && (
                        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                            <i className="fa-solid fa-triangle-exclamation mr-2"></i>{parseError}
                        </div>
                    )}

                    {!header && !parseError && (
                        <p className="text-xs text-slate-500">No file selected. Choose an organization export (.ndjson) generated from the hosted customer portal.</p>
                    )}

                    {header && (
                        <>
                            <div className="rounded-lg border border-slate-700/60 bg-slate-900/60 px-3 py-2 text-xs text-slate-300 space-y-1">
                                <div><span className="text-slate-500 uppercase tracking-wider mr-2">File:</span>{filename}</div>
                                <div><span className="text-slate-500 uppercase tracking-wider mr-2">Source org:</span>{header.sourceOrg?.name || '—'}</div>
                                <div><span className="text-slate-500 uppercase tracking-wider mr-2">Total rows:</span>{totalRows.toLocaleString()}</div>
                                <div><span className="text-slate-500 uppercase tracking-wider mr-2">Tables:</span>{nonEmptyTables.length}</div>
                            </div>

                            <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-700/40">
                                <table className="w-full text-xs">
                                    <tbody>
                                        {nonEmptyTables.map((t) => (
                                            <tr key={t} className="border-b border-slate-800/50">
                                                <td className="px-3 py-1.5 text-slate-300 font-mono">{t}</td>
                                                <td className="px-3 py-1.5 text-right text-slate-400">{(header.manifest[t] || 0).toLocaleString()}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                                <i className="fa-solid fa-circle-info mr-2"></i>
                                Import is refused if this instance already contains users/requests/operations/etc.
                                Catalog references (ships, items) are re-linked against this instance's synced
                                catalogs — run the Database Tools catalog syncs first for best coverage.
                            </div>

                            {users.length > 0 && (
                                <div className="rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-2">
                                    <label className="block text-[11px] font-semibold text-sky-300 mb-1 uppercase tracking-wider">Which of these is you?</label>
                                    <p className="text-[11px] text-slate-400 mb-2">Your admin account is merged with this member's records — kept as Admin, same Discord login — so you aren't duplicated. Required, since this instance already has your admin account.</p>
                                    <select
                                        value={mergeUserId ?? ''}
                                        onChange={(e) => setMergeUserId(e.target.value ? Number(e.target.value) : null)}
                                        disabled={isImporting}
                                        className="w-full bg-slate-900 border border-white/10 rounded-sm px-3 py-2 text-xs text-slate-200"
                                    >
                                        <option value="">— Select your member —</option>
                                        {users.map((u) => (
                                            <option key={u.id} value={u.id}>{u.label}{u.sub ? ` · ${u.sub}` : ''}</option>
                                        ))}
                                    </select>
                                </div>
                            )}
                            <div className="flex gap-2 pt-2">
                                <button
                                    onClick={handleImport}
                                    disabled={isImporting || (users.length > 0 && mergeUserId == null)}
                                    className="text-[10px] bg-amber-600 hover:bg-amber-500 text-white px-4 py-2 rounded-sm font-bold uppercase transition-colors disabled:opacity-50"
                                >
                                    {isImporting ? <><i className="fa-solid fa-spinner animate-spin mr-1"></i>Importing…</> : <><i className="fa-solid fa-upload mr-1"></i>Run Import</>}
                                </button>
                                <button onClick={clear} disabled={isImporting} className="text-[10px] bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white px-4 py-2 rounded-sm font-bold uppercase transition-colors disabled:opacity-50">Clear</button>
                            </div>

                            {(isImporting || logLines.length > 0) && (
                                <div className="space-y-2 pt-2">
                                    <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                                        <div className={`h-full ${result ? 'bg-emerald-500' : 'bg-sky-500'} transition-all duration-300`} style={{ width: `${pct}%` }} />
                                    </div>
                                    <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-700/40 bg-slate-950 p-2 font-mono text-[10px] text-slate-400 space-y-0.5">
                                        {logLines.map((l) => <div key={l.id} className={l.text.startsWith('⚠') ? 'text-amber-400' : l.text.startsWith('✗') ? 'text-rose-400' : ''}>{l.text}</div>)}
                                    </div>
                                </div>
                            )}
                        </>
                    )}

                    {result && (
                        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 space-y-1">
                            <div><i className="fa-solid fa-check mr-2"></i>Imported {result.rowsInserted.toLocaleString()} rows across {result.tablesProcessed} tables. Sequences reset: {result.sequencesReset.length}.</div>
                            {result.rowsSkipped > 0 && <div className="text-amber-300">Skipped {result.rowsSkipped} rows from unrecognized tables.</div>}
                            {result.warnings.length > 0 && (
                                <details className="mt-1">
                                    <summary className="cursor-pointer text-amber-300">{result.warnings.length} warning(s)</summary>
                                    <ul className="mt-1 list-disc list-inside text-amber-200/80 space-y-0.5">
                                        {warningRows.map((w) => <li key={w.id}>{w.text}</li>)}
                                    </ul>
                                </details>
                            )}
                            <div className="text-slate-300 pt-1">Reload the app to load the imported data.</div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default OrgImportTab;
