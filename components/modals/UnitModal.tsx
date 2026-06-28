
import React, { useState, useCallback } from 'react';
import { OrganizationalUnit } from '../../types';
import { useData } from '../../contexts/DataContext';
import { useMembers } from '../../contexts/MembersContext';
import { useAuth } from '../../contexts/AuthContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface UnitModalProps {
    isOpen: boolean;
    onClose: () => void;
    unit?: OrganizationalUnit;
}

const UnitModal: React.FC<UnitModalProps> = ({ isOpen, onClose, unit }) => {
    const { radioChannels = [] } = useData();
    const { units, addUnit, updateUnit, members } = useMembers();
    const { hasPermission } = useAuth();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [parentUnitId, setParentUnitId] = useState<string>('');
    const [leaderId, setLeaderId] = useState<string>('');
    const [logoUrl, setLogoUrl] = useState('');
    const [motto, setMotto] = useState('');
    const [description, setDescription] = useState('');
    const [sortOrder, setSortOrder] = useState<number>(0);
    const [hasRadioChannel, setHasRadioChannel] = useState(true);
    const [linkedChannelId, setLinkedChannelId] = useState<string>('');
    const [isRestricted, setIsRestricted] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const isEditing = !!unit;

    // Only admins can change structure. Unit leaders can only edit details.
    const canManageStructure = hasPermission('admin:config:units');

    // Seed/reset the editable form when the modal opens or the edited unit
    // changes while open. Adjusts state during render (React's documented
    // pattern) instead of in an effect; the controlled fields must stay
    // user-editable so they cannot be derived during render.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevUnit, setPrevUnit] = useState(unit);
    if (isOpen !== prevIsOpen || unit !== prevUnit) {
        setPrevIsOpen(isOpen);
        setPrevUnit(unit);
        if (isOpen) {
            if (unit) {
                setName(unit.name);
                setParentUnitId(unit.parentUnitId !== undefined && unit.parentUnitId !== null ? unit.parentUnitId.toString() : '');
                setLeaderId(unit.leaderId !== undefined && unit.leaderId !== null ? unit.leaderId.toString() : '');
                setLogoUrl(unit.logoUrl || '');
                setMotto(unit.motto || '');
                setDescription(unit.description || '');
                setSortOrder(unit.sortOrder || 0);
                setHasRadioChannel(unit.hasRadioChannel !== false);
                setLinkedChannelId(unit.linkedChannelId || '');
                setIsRestricted(!!unit.isRestricted);
            } else {
                setName('');
                setParentUnitId('');
                setLeaderId('');
                setLogoUrl('');
                setMotto('');
                setDescription('');
                setSortOrder(0);
                setHasRadioChannel(true);
                setLinkedChannelId('');
                setIsRestricted(false);
            }
            setIsLoading(false);
        }
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setIsLoading(true);
        // Use null instead of undefined for DB updates to properly clear fields
        const unitData = {
            name: name.trim(),
            parentUnitId: parentUnitId ? parseInt(parentUnitId, 10) : null,
            leaderId: leaderId ? parseInt(leaderId, 10) : null,
            logoUrl: logoUrl.trim() || null,
            motto: motto.trim() || null,
            description: description.trim() || null,
            sortOrder: sortOrder || 0,
            hasRadioChannel,
            linkedChannelId: hasRadioChannel && linkedChannelId ? linkedChannelId : null,
            isRestricted,
        };

        try {
            if (isEditing && unit) {
                // Do NOT spread ...unit here. The unit from the tree view carries a
                // recursive 'children' array; passing it to the RPC causes payload
                // bloat and circular-reference errors. Only pass the ID and new data.
                await updateUnit({ id: unit.id, ...unitData });
                addToast("Unit Updated", <i className="fa-solid fa-check"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: "Unit details have been saved successfully." });
            } else {
                await addUnit(unitData);
                addToast("Unit Created", <i className="fa-solid fa-check"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: "New unit has been added to the organizational structure." });
            }
            onClose();
        } catch (err) {
            console.error("Failed to save unit:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save unit. Please try again." });
            setIsLoading(false);
        }
    }, [name, parentUnitId, leaderId, logoUrl, motto, description, sortOrder, hasRadioChannel, linkedChannelId, isRestricted, isEditing, unit, addUnit, updateUnit, onClose, addToast]);

    const availableParents = [...units].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)).filter(u => u.id !== unit?.id);

    const inputClass = "w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all disabled:opacity-50 disabled:cursor-not-allowed";
    const labelClass = "block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2";

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Unit' : 'Create Unit'}
            subtitle="Organizational Structure"
            icon="fa-solid fa-sitemap"
            color="sky"
            width="max-w-xl"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                {/* Body */}
                <div className="p-6 space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className={labelClass}>Unit Name</label>
                            <input type="text" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} required disabled={isLoading} />
                        </div>
                        <div>
                            <label className={labelClass}>Parent Unit</label>
                            <select
                                value={parentUnitId}
                                onChange={(e) => setParentUnitId(e.target.value)}
                                className={inputClass}
                                disabled={isLoading || !canManageStructure}
                            >
                                <option value="">- Top Level -</option>
                                {availableParents.map(parent => <option key={parent.id} value={parent.id}>{parent.name}</option>)}
                            </select>
                            {!canManageStructure && <p className="text-[9px] text-slate-500 mt-1 italic">Contact admin to change hierarchy.</p>}
                        </div>
                    </div>

                    <div>
                        <label className={labelClass}>Unit Leader</label>
                        <select value={leaderId} onChange={(e) => setLeaderId(e.target.value)} className={inputClass} disabled={isLoading}>
                            <option value="">- No Assigned Leader -</option>
                            {members.map(m => <option key={m.id} value={m.id}>{m.name} ({m.rank?.name || 'Unranked'})</option>)}
                        </select>
                    </div>

                    <div className="border-t border-slate-700/50 pt-6">
                        <h4 className="text-sm font-bold text-white mb-4">Branding & Identity</h4>
                        <div>
                            <label className={labelClass}>Logo URL</label>
                            <input type="url" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://..." className={inputClass} disabled={isLoading} />
                        </div>
                        <div className="mt-4">
                            <label className={labelClass}>Motto</label>
                            <input type="text" value={motto} onChange={(e) => setMotto(e.target.value)} placeholder="e.g. Semper Fidelis" className={inputClass} disabled={isLoading} />
                        </div>
                        <div className="mt-4">
                            <label className={labelClass}>Mission Statement / Description</label>
                            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className={`${inputClass} resize-none`} disabled={isLoading} />
                        </div>
                    </div>

                    <div className="border-t border-slate-700/50 pt-6">
                        <h4 className="text-sm font-bold text-white mb-4">Radio Configuration</h4>
                        <label className="flex items-center gap-3 cursor-pointer group">
                            <input
                                type="checkbox"
                                checked={hasRadioChannel}
                                onChange={(e) => {
                                    setHasRadioChannel(e.target.checked);
                                    if (!e.target.checked) setLinkedChannelId('');
                                }}
                                className="w-4 h-4 rounded-sm border-slate-600 bg-slate-950 text-sky-500 focus:ring-sky-500 focus:ring-offset-0 cursor-pointer"
                                disabled={isLoading}
                            />
                            <span className="text-sm text-slate-300 group-hover:text-white transition-colors">Create radio frequency for this unit</span>
                        </label>
                        <p className="text-[10px] text-slate-500 mt-1.5 ml-7">
                            {hasRadioChannel
                                ? 'A tactical radio channel will be available for this unit.'
                                : 'This unit will be structural only — no radio frequency will be generated.'}
                        </p>
                        {hasRadioChannel && radioChannels.length > 0 && (
                            <div className="mt-4">
                                <label className={labelClass}>Link Existing Channel (Optional)</label>
                                <select
                                    value={linkedChannelId}
                                    onChange={(e) => setLinkedChannelId(e.target.value)}
                                    className={inputClass}
                                    disabled={isLoading}
                                >
                                    <option value="">- Auto-generate frequency -</option>
                                    {radioChannels.map(ch => <option key={ch.id} value={ch.id}>{ch.name} ({ch.id})</option>)}
                                </select>
                                <p className="text-[10px] text-slate-500 mt-1">Link to an existing channel instead of auto-generating one.</p>
                            </div>
                        )}
                    </div>

                    <div className="border-t border-slate-700/50 pt-6">
                        <h4 className="text-sm font-bold text-white mb-4">Visibility</h4>
                        <label className="flex items-start gap-3 cursor-pointer group">
                            <input
                                type="checkbox"
                                checked={isRestricted}
                                onChange={(e) => setIsRestricted(e.target.checked)}
                                className="mt-0.5 w-4 h-4 rounded-sm border-slate-600 bg-slate-950 text-amber-500 focus:ring-amber-500 focus:ring-offset-0 cursor-pointer"
                                disabled={isLoading}
                            />
                            <div>
                                <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                                    <i className="fa-solid fa-lock text-amber-400/80 mr-1.5 text-xs"></i>
                                    Restrict this unit to members only
                                </span>
                                <p className="text-[10px] text-slate-500 mt-1 leading-relaxed">
                                    When enabled, the unit appears in the Org Chart with a lock badge, but its detail page (members, feed, operations) is only accessible to members of this unit and org admins.
                                </p>
                            </div>
                        </label>
                    </div>

                    <div>
                        <label className={labelClass}>Sort Order (Precedence)</label>
                        <input
                            type="number"
                            value={sortOrder}
                            onChange={(e) => setSortOrder(parseInt(e.target.value) || 0)}
                            className={inputClass}
                            disabled={isLoading || !canManageStructure}
                            placeholder="0"
                        />
                        {!canManageStructure && <p className="text-[9px] text-slate-500 mt-1 italic">Contact admin to change precedence.</p>}
                    </div>
                </div>

                {/* Footer */}
                <div className="flex justify-end items-center p-6 bg-slate-900/50 border-t border-white/5 rounded-b-2xl shrink-0 gap-3">
                    <button type="button" onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors" disabled={isLoading}>Cancel</button>
                    <button type="submit" className="px-6 py-2 text-xs font-bold uppercase tracking-wider text-white bg-sky-600 rounded-lg hover:bg-sky-500 transition-all shadow-lg shadow-sky-900/20 disabled:bg-slate-800 border border-sky-500/50" disabled={isLoading}>
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : (isEditing ? 'Save Changes' : 'Create Unit')}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default UnitModal;
