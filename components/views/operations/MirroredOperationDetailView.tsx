import React, { useState, useEffect, useCallback } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useNotification } from '../../../contexts/NotificationContext';
import { MirroredOperation, RSVPStatus } from '../../../types';
import TacticalBoardViewer from './TacticalBoardViewer';

interface Props {
    mirror: MirroredOperation;
    onBack: () => void;
}

const RSVP_BUTTONS = [
    { status: RSVPStatus.Accepted, label: 'Accept', icon: 'fa-circle-check', active: 'bg-green-500/20 text-green-400 border-green-500/40' },
    { status: RSVPStatus.Tentative, label: 'Maybe', icon: 'fa-circle-question', active: 'bg-amber-500/20 text-amber-400 border-amber-500/40' },
    { status: RSVPStatus.Declined, label: 'Decline', icon: 'fa-circle-xmark', active: 'bg-red-500/20 text-red-400 border-red-500/40' },
] as const;

const Section: React.FC<{ title: string; icon: string; children: React.ReactNode }> = ({ title, icon, children }) => (
    <div className="bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden">
        <div className="px-5 py-3 bg-slate-800/40 border-b border-slate-700/40">
            <p className="text-[10px] text-slate-400 uppercase font-black tracking-[0.15em] flex items-center gap-2">
                <i className={`fa-solid ${icon}`}></i> {title}
            </p>
        </div>
        <div className="p-5">{children}</div>
    </div>
);

// Read-only mirror of a joint operation hosted by an allied instance. Renders the
// synced snapshot; the only interactive control is the local member's RSVP, which
// syncs back to the host. No edit affordances exist here by construction.
const MirroredOperationDetailView: React.FC<Props> = ({ mirror: initialMirror, onBack }) => {
    const { rpcAction } = useData();
    const { currentUser } = useAuth();
    const { addToast } = useNotification();
    const [mirror, setMirror] = useState<MirroredOperation>(initialMirror);
    const [rsvping, setRsvping] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const fresh = await rpcAction('mirror:get', { id: initialMirror.id });
            if (fresh) setMirror(fresh);
        } catch { /* keep current */ }
    }, [rpcAction, initialMirror.id]);

    useEffect(() => {
        // Pull the latest snapshot from the host, then re-read locally.
        rpcAction('mirror:poll', { id: initialMirror.id }).catch(() => undefined).then(() => refresh());
    }, [rpcAction, initialMirror.id, refresh]);

    const op = mirror.snapshot;
    const myParticipation = mirror.myParticipation?.find(p => p.userId === currentUser?.id);
    const myRsvp = myParticipation?.rsvpStatus || 'Pending';
    const hostName = mirror.hostPeerName || 'an allied org';

    const handleRsvp = async (status: string) => {
        setRsvping(true);
        try {
            await rpcAction('mirror:rsvp', { id: mirror.id, rsvpStatus: status });
            addToast('RSVP Updated', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: `You're marked "${status}" for this operation.` });
            await refresh();
        } catch {
            addToast('RSVP Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: 'Could not reach the host instance.' });
        } finally { setRsvping(false); }
    };

    const handleWithdraw = async () => {
        setRsvping(true);
        try {
            // Deletes locally + pushes the removal to the host so its allied
            // participant row doesn't linger as a ghost RSVP.
            await rpcAction('mirror:rsvp_remove', { id: mirror.id });
            addToast('RSVP Withdrawn', <i className="fa-solid fa-check"></i>, 'bg-green-500/10 text-green-400 border-green-500/50', { description: 'Your RSVP was removed from this operation.' });
            await refresh();
        } catch {
            addToast('Withdraw Failed', <i className="fa-solid fa-xmark"></i>, 'bg-red-500/10 text-red-400 border-red-500/50', { description: 'Could not reach the host instance.' });
        } finally { setRsvping(false); }
    };

    const backBtn = (
        <button onClick={onBack} className="text-xs text-slate-400 hover:text-white flex items-center gap-2">
            <i className="fa-solid fa-arrow-left"></i> Back to Operations
        </button>
    );

    if (!op) {
        return (
            <div className="h-full overflow-y-auto custom-scrollbar p-6 lg:p-8 space-y-6">
                {backBtn}
                <div className="text-center text-slate-500 py-16">
                    <i className="fa-solid fa-satellite-dish text-2xl mb-3"></i>
                    <p>This allied operation hasn't been shared yet, or has been withdrawn by {hostName}.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="h-full overflow-y-auto custom-scrollbar p-6 lg:p-8 space-y-6">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                {backBtn}
                <span className="text-[10px] font-black uppercase tracking-wider px-3 py-1.5 rounded-full border bg-cyan-500/10 text-cyan-300 border-cyan-500/30">
                    <i className="fa-solid fa-eye mr-1.5"></i> Read-only · Hosted by {hostName}
                </span>
            </div>

            <div className="bg-linear-to-r from-slate-800/60 to-slate-900/40 rounded-xl border border-slate-700/40 p-6">
                <div className="flex items-start gap-3 flex-wrap">
                    <h1 className="text-2xl font-black text-white tracking-tight">{op.name}</h1>
                    <span className="text-[10px] font-black uppercase px-2.5 py-1 rounded-full border bg-slate-700/40 text-slate-300 border-slate-600/40 mt-1">{op.status}</span>
                    <span className="text-[10px] font-black uppercase px-2.5 py-1 rounded-full border bg-slate-700/40 text-slate-300 border-slate-600/40 mt-1">{op.type}</span>
                </div>
                {op.description && <p className="text-slate-400 text-sm mt-3">{op.description}</p>}
                {(op.scheduledStart || op.locationText) && (
                    <div className="flex flex-wrap gap-4 mt-3 text-xs text-slate-500">
                        {op.scheduledStart && <span><i className="fa-solid fa-clock mr-1.5"></i>{new Date(op.scheduledStart).toLocaleString()}</span>}
                        {op.locationText && <span><i className="fa-solid fa-location-dot mr-1.5"></i>{op.locationText}</span>}
                    </div>
                )}
            </div>

            {/* RSVP (accepted mirrors only) */}
            {mirror.accepted && (
                <Section title="Your RSVP" icon="fa-reply">
                    <div className="flex items-center gap-2 flex-wrap">
                        {RSVP_BUTTONS.map(b => (
                            <button key={b.status} onClick={() => handleRsvp(b.status)} disabled={rsvping}
                                className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all border disabled:opacity-50 ${
                                    myRsvp === b.status ? b.active : 'bg-slate-800/50 text-slate-400 border-slate-700/50 hover:bg-slate-700/50'
                                }`}>
                                <i className={`fa-solid ${b.icon}`}></i> {b.label}
                            </button>
                        ))}
                        {myParticipation && (
                            <button onClick={handleWithdraw} disabled={rsvping}
                                className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all border disabled:opacity-50 bg-slate-800/50 text-red-400/80 border-red-500/20 hover:bg-red-500/10 hover:text-red-300">
                                <i className="fa-solid fa-user-minus"></i> Withdraw
                            </button>
                        )}
                        {rsvping && <i className="fa-solid fa-spinner animate-spin text-slate-500"></i>}
                    </div>
                </Section>
            )}

            {/* SMEAC */}
            {(op.roe || op.commanderNotes) && (
                <Section title="Orders" icon="fa-scroll">
                    {op.roe && <div className="mb-3"><p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Rules of Engagement</p><p className="text-sm text-slate-300 whitespace-pre-wrap">{op.roe}</p></div>}
                    {op.commanderNotes && <div><p className="text-[10px] text-slate-500 uppercase font-bold mb-1">Commander's Notes</p><p className="text-sm text-slate-300 whitespace-pre-wrap">{op.commanderNotes}</p></div>}
                </Section>
            )}

            {!!op.phases?.length && (
                <Section title="Phases" icon="fa-diagram-project">
                    <div className="space-y-2">
                        {op.phases.map(ph => (
                            <div key={ph.id} className="flex items-center justify-between p-2.5 rounded-lg bg-slate-800/30 border border-slate-700/30">
                                <span className="text-sm text-white font-semibold">{ph.name}</span>
                                <span className="text-[10px] text-slate-500 uppercase">{ph.status}</span>
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {!!op.tasks?.length && (
                <Section title="Tasking" icon="fa-list-check">
                    <div className="space-y-2">
                        {op.tasks.map(t => (
                            <div key={t.id} className="flex items-center justify-between p-2.5 rounded-lg bg-slate-800/30 border border-slate-700/30">
                                <span className="text-sm text-slate-200">{t.title}</span>
                                <span className="text-[10px] text-slate-500 uppercase">{t.status} · {t.priority}</span>
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {!!op.commandNodes?.length && (
                <Section title="Command Structure" icon="fa-sitemap">
                    <div className="flex flex-wrap gap-2">
                        {op.commandNodes.map(n => (
                            <span key={n.id} className="text-xs px-2.5 py-1 rounded-md bg-slate-800/40 border border-slate-700/40 text-slate-300">{n.label}</span>
                        ))}
                    </div>
                </Section>
            )}

            <Section title="Participants" icon="fa-users">
                <div className="space-y-1.5">
                    {(op.participants || []).map(p => (
                        <div key={`h-${p.userId}`} className="flex items-center justify-between text-sm">
                            <span className="text-slate-200">{p.user?.name || 'Member'}{p.roleRequested ? <span className="text-slate-500"> · {p.roleRequested}</span> : null}</span>
                            <span className="text-[10px] text-slate-500 uppercase">{p.rsvpStatus || (p.isReady ? 'Ready' : '')}</span>
                        </div>
                    ))}
                    {(op.alliedParticipants || []).map(p => (
                        <div key={`a-${p.peerId}-${p.remoteUserHandle}`} className="flex items-center justify-between text-sm">
                            <span className="text-cyan-300">{p.displayName || p.remoteUserHandle}<span className="text-slate-500"> · ally</span></span>
                            <span className="text-[10px] text-slate-500 uppercase">{p.rsvpStatus}</span>
                        </div>
                    ))}
                    {!(op.participants?.length || op.alliedParticipants?.length) && <p className="text-xs text-slate-600 italic">No participants yet.</p>}
                </div>
            </Section>

            {/* Tactical board — read-only render of the synced snapshot. */}
            {!!op.boardElements?.length && (
                <Section title="Tactical Board" icon="fa-chess-board">
                    <TacticalBoardViewer boardElements={op.boardElements} />
                </Section>
            )}
        </div>
    );
};

export default MirroredOperationDetailView;
