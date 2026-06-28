import React, { useState, useCallback, useEffect, useRef } from 'react';
import { IntelThreatLevel, BulletinDuration } from '../../types';
import { useMembers } from '../../contexts/MembersContext';
import { useIntel } from '../../contexts/IntelContext';
import { useAuth } from '../../contexts/AuthContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface CreateBulletinModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const DURATION_OPTIONS: { value: BulletinDuration; label: string }[] = [
    { value: 15, label: '15m' },
    { value: 30, label: '30m' },
    { value: 60, label: '1h' },
    { value: 120, label: '2h' },
    { value: 240, label: '4h' },
    { value: 0, label: 'Indefinite' },
];

const CreateBulletinModal: React.FC<CreateBulletinModalProps> = ({ isOpen, onClose }) => {
    const { securityClearances, limitingMarkers } = useMembers();
    const { createBulletin } = useIntel();
    const { currentUser } = useAuth();
    const { addToast } = useNotification();

    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [threatLevel, setThreatLevel] = useState<IntelThreatLevel>(IntelThreatLevel.Medium);
    const [location, setLocation] = useState('');
    const [duration, setDuration] = useState<BulletinDuration>(60);
    const [classificationLevel, setClassificationLevel] = useState('0');
    const [selectedMarkers, setSelectedMarkers] = useState<Set<number>>(() => new Set());
    const [sharedWithAllies, setSharedWithAllies] = useState(false);
    const [isLoading, setIsLoading] = useState(false);

    const wasOpenRef = useRef(false);

    useEffect(() => {
        if (isOpen && !wasOpenRef.current) {
            setTitle('');
            setBody('');
            setThreatLevel(IntelThreatLevel.Medium);
            setLocation('');
            setDuration(60);
            setClassificationLevel('0');
            setSelectedMarkers(new Set());
            setSharedWithAllies(false);
            setIsLoading(false);
        }
        wasOpenRef.current = isOpen;
    }, [isOpen]);

    const handleToggleMarker = (id: number) => {
        setSelectedMarkers(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!title.trim() || !body.trim() || !currentUser) return;

        setIsLoading(true);
        try {
            await createBulletin({
                title: title.trim(),
                body: body.trim(),
                threatLevel,
                location: location.trim() || null,
                durationMinutes: duration,
                classificationLevel: parseInt(classificationLevel),
                markerIds: Array.from(selectedMarkers),
                createdById: currentUser.id,
                sharedWithAllies,
            });
            addToast(
                'Bulletin Published',
                <i className="fa-solid fa-satellite-dish"></i>,
                'bg-amber-600 text-white shadow-amber-900/50',
                { description: 'Your intel bulletin has been broadcast successfully.' }
            );
            onClose();
        } catch (err) {
            console.error(err);
            addToast("Error", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to create bulletin. Please try again." });
        } finally {
            setIsLoading(false);
        }
    }, [title, body, threatLevel, location, duration, classificationLevel, selectedMarkers, sharedWithAllies, createBulletin, currentUser, onClose, addToast]);

    const threatLevels = [IntelThreatLevel.Critical, IntelThreatLevel.High, IntelThreatLevel.Medium, IntelThreatLevel.Low];

    const threatColors: Record<string, string> = {
        'Critical': 'bg-red-600 text-white border-red-400 shadow-[0_0_10px_rgba(239,68,68,0.3)]',
        'High': 'bg-orange-600 text-white border-orange-400 shadow-[0_0_10px_rgba(249,115,22,0.3)]',
        'Medium': 'bg-amber-600 text-white border-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.3)]',
        'Low': 'bg-sky-600 text-white border-sky-400 shadow-[0_0_10px_rgba(14,165,233,0.3)]',
    };

    const inputClass = "w-full bg-slate-950/50 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50 outline-hidden transition-all";
    const labelClass = "block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title="Issue Intel Bulletin"
            subtitle="Time-Sensitive Intelligence"
            icon="fa-solid fa-satellite-dish"
            color="amber"
            width="max-w-xl"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                <div className="p-6 space-y-5 overflow-y-auto custom-scrollbar flex-1">
                    <div>
                        <label className={labelClass}>Title <span className="text-slate-600">({title.length}/120)</span></label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value.slice(0, 120))}
                            placeholder="Hostile patrol spotted near Nyx gateway"
                            className={inputClass}
                            required
                            disabled={isLoading}
                            maxLength={120}
                        />
                    </div>

                    <div>
                        <label className={labelClass}>Body <span className="text-slate-600">({body.length}/500)</span></label>
                        <textarea
                            value={body}
                            onChange={(e) => setBody(e.target.value.slice(0, 500))}
                            rows={3}
                            placeholder="Provide actionable intelligence details..."
                            className={`${inputClass} resize-none`}
                            required
                            disabled={isLoading}
                            maxLength={500}
                        />
                    </div>

                    <div>
                        <label className={labelClass}>Threat Level</label>
                        <div className="grid grid-cols-4 gap-1.5">
                            {threatLevels.map(level => (
                                <button
                                    key={level}
                                    type="button"
                                    onClick={() => setThreatLevel(level)}
                                    className={`py-2 text-[10px] font-black uppercase rounded border transition-all ${
                                        threatLevel === level
                                            ? threatColors[level]
                                            : 'bg-slate-900 text-slate-500 border-slate-800 hover:border-slate-600'
                                    }`}
                                >
                                    {level}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className={labelClass}>Location <span className="text-slate-600">(optional)</span></label>
                        <input
                            type="text"
                            value={location}
                            onChange={(e) => setLocation(e.target.value)}
                            placeholder="Stanton, Pyro, Nyx..."
                            className={inputClass}
                            disabled={isLoading}
                        />
                    </div>

                    <div>
                        <label className={labelClass}>Duration</label>
                        <div className="grid grid-cols-6 gap-1.5">
                            {DURATION_OPTIONS.map(opt => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => setDuration(opt.value)}
                                    className={`py-2.5 text-xs font-black uppercase rounded border transition-all ${
                                        duration === opt.value
                                            ? 'bg-amber-600 text-white border-amber-400 shadow-[0_0_10px_rgba(245,158,11,0.3)]'
                                            : 'bg-slate-900 text-slate-500 border-slate-800 hover:border-slate-600'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="bg-slate-950/50 p-4 rounded-xl border border-slate-800 space-y-4">
                        <h4 className="text-[10px] font-black text-sky-500 uppercase tracking-widest flex items-center gap-2">
                            <i className="fa-solid fa-lock"></i> Classification & Privacy
                        </h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className={labelClass}>Classification Level</label>
                                <select value={classificationLevel} onChange={e => setClassificationLevel(e.target.value)} className={inputClass} disabled={isLoading}>
                                    {securityClearances.map(c => <option key={c.id} value={c.level}>Level {c.level} - {c.name}</option>)}
                                </select>
                            </div>
                            <div>
                                <label className={labelClass}>Limiting Markers</label>
                                <div className="flex flex-wrap gap-1 max-h-20 overflow-y-auto pr-1">
                                    {limitingMarkers.map(m => (
                                        <button
                                            key={m.id}
                                            type="button"
                                            onClick={() => handleToggleMarker(m.id)}
                                            className={`text-[8px] px-1.5 py-0.5 rounded border uppercase font-black transition-all ${
                                                selectedMarkers.has(m.id) ? 'bg-sky-600 text-white border-sky-400' : 'bg-slate-900 text-slate-500 border-slate-800 hover:border-slate-700'
                                            }`}
                                        >
                                            {m.code}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        </div>
                        <div className="pt-3 border-t border-slate-800/70">
                            <button
                                type="button"
                                onClick={() => setSharedWithAllies(v => !v)}
                                disabled={isLoading}
                                className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border text-xs font-bold uppercase tracking-wider transition-all ${
                                    sharedWithAllies
                                        ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40'
                                        : 'bg-slate-900 text-slate-500 border-slate-800 hover:border-slate-700'
                                }`}
                            >
                                <span className="flex items-center gap-2">
                                    <i className="fa-solid fa-handshake"></i>
                                    Share with Allies
                                </span>
                                <span className={`flex h-5 w-9 items-center rounded-full p-0.5 transition-colors ${sharedWithAllies ? 'bg-emerald-500/80 justify-end' : 'bg-slate-700 justify-start'}`}>
                                    <span className="h-4 w-4 rounded-full bg-white"></span>
                                </span>
                            </button>
                            <p className="mt-1.5 text-[10px] text-slate-500">
                                Allied orgs you've enabled the bulletin channel for can pull this bulletin (subject to clearance).
                            </p>
                        </div>
                    </div>

                </div>

                <div className="p-4 border-t border-white/5 bg-slate-900/50 flex justify-end gap-3 rounded-b-xl">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase text-slate-400 hover:text-white transition-colors" disabled={isLoading}>Cancel</button>
                    <button type="submit" disabled={isLoading || !title.trim() || !body.trim()} className="px-6 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-black uppercase tracking-widest transition-all shadow-lg shadow-amber-900/20 disabled:opacity-50">
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : 'Broadcast Bulletin'}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default CreateBulletinModal;
