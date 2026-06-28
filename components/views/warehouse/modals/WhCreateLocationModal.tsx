import React, { useState } from 'react';
import { useData } from '../../../../contexts/DataContext';
import WindowFrame from '../../../layout/WindowFrame';
import type { QmLocation } from '../../../../types';
import { useNotification } from '../../../../contexts/NotificationContext';

interface Props {
    isOpen: boolean;
    locations: QmLocation[];
    onClose: () => void;
    onSubmitted: () => void;
}

export default function WhCreateLocationModal({ isOpen, locations, onClose, onSubmitted }: Props) {
    const { rpcAction } = useData();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [type, setType] = useState<QmLocation['type']>('station');
    const [parentId, setParentId] = useState<number | null>(null);
    const [description, setDescription] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // Reset the editable form fields each time the modal transitions to open.
    // Adjusting state during render (React-documented pattern) is equivalent to
    // the old reset-on-open effect but runs before paint without a synchronous
    // effect setState.
    const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
    if (isOpen !== prevIsOpen) {
        setPrevIsOpen(isOpen);
        if (isOpen) {
            setName('');
            setType('station');
            setParentId(null);
            setDescription('');
            setSubmitting(false);
        }
    }

    if (!isOpen) return null;

    const valid = name.trim().length > 0;

    const submit = async () => {
        if (!valid || submitting) return;
        setSubmitting(true);
        try {
            await rpcAction('warehouse:create_location', {
                name: name.trim(),
                type,
                parentId: parentId ?? undefined,
                description: description.trim() || undefined,
            });
            addToast('Location created', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50');
            onSubmitted();
            onClose();
        } catch (err: any) {
            addToast('Could not create location', <i className="fa-solid fa-xmark" />,
                'bg-red-500/10 text-red-400 border-red-500/50', { description: err?.message });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Place where stock can sit"
            subtitle="New Location"
            icon="fa-solid fa-location-dot"
            color="sky"
            width="max-w-md"
        >
            <div className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar flex-1">
                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Name</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Port Olisar Hangar B"
                            maxLength={80}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden"
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Type</label>
                            <select
                                value={type}
                                onChange={(e) => setType(e.target.value as QmLocation['type'])}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden"
                            >
                                <option value="station">Station</option>
                                <option value="hangar">Hangar</option>
                                <option value="ship">Ship</option>
                                <option value="custom">Custom</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Parent</label>
                            <select
                                value={parentId ?? ''}
                                onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}
                                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:ring-2 focus:ring-sky-500 outline-hidden"
                            >
                                <option value="">— none —</option>
                                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                            </select>
                        </div>
                    </div>

                    <div>
                        <label className="block text-[10px] font-black text-slate-400 uppercase tracking-[0.25em] mb-2">Description (optional)</label>
                        <textarea
                            rows={2}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            maxLength={400}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:ring-2 focus:ring-sky-500 outline-hidden resize-none"
                        />
                    </div>
                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button onClick={onClose} disabled={submitting}
                        className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors disabled:opacity-50">
                        Cancel
                    </button>
                    <button onClick={submit} disabled={!valid || submitting}
                        className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-sky-600 hover:bg-sky-500 border border-sky-500/40 rounded-lg shadow-lg shadow-sky-900/30 transition disabled:opacity-50 disabled:cursor-not-allowed">
                        {submitting ? <><i className="fa-solid fa-spinner fa-spin" />Creating…</> : <><i className="fa-solid fa-plus" />Create Location</>}
                    </button>
                </div>
            </div>
        </WindowFrame>
    );
}
