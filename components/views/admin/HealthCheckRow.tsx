import React from 'react';

export interface HealthCheckResult {
    check: string;
    status: 'OK' | 'WARNING' | 'ERROR';
    // Nullable: the schema-version and secret-encryption rows are diagnostics, not counts,
    // and report null. The server has always typed it this way; this side used to claim
    // otherwise and render a blank cell.
    count: number | null;
    action?: string;
}

/** One row of the Database Tools health report. */
export const HealthCheckRow: React.FC<{ item: HealthCheckResult }> = ({ item }) => (
    <div className="flex items-center justify-between p-3 rounded-sm bg-slate-800/30 border border-slate-700/30">
        <div>
            <p className="text-sm font-bold text-slate-200">{item.check}</p>
            {/* Configuration checks (schema version, session secret, anon key, encryption) carry
                no record count — print nothing rather than "Records: null". */}
            {item.count != null && <p className="text-xs text-slate-500">Records: {item.count}</p>}
            {/* The fix instruction. The server has always sent it ("Re-run schema.sql", "Rotate
                JWT_SECRET ...") but this tab never showed it, so a WARNING told the admin that
                something was wrong and not what to do about it. */}
            {item.action && item.status !== 'OK' && (
                <p className="text-xs text-amber-300/90 mt-0.5"><i className="fa-solid fa-wrench mr-1"></i>{item.action}</p>
            )}
        </div>
        {/* Three tones, not two. ERROR used to render in the same amber as WARNING, so "your
            credentials are unrecoverable" looked identical to "you can remove the old key now". */}
        <div className={`px-2 py-0.5 rounded text-[10px] font-black uppercase border ${item.status === 'OK' ? 'text-green-400 border-green-500/30 bg-green-500/10' :
                item.status === 'ERROR' ? 'text-red-300 border-red-500/40 bg-red-500/15 animate-pulse' :
                    'text-amber-400 border-amber-500/30 bg-amber-500/10 animate-pulse'
            }`}>
            {item.status}
        </div>
    </div>
);
