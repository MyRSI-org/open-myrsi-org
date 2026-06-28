
import React, { useState, useCallback, useMemo } from 'react';
import { Location, LocationType } from '../../types';
import { useConfig } from '../../contexts/ConfigContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface LocationModalProps {
    isOpen: boolean;
    onClose: () => void;
    location?: Location;
}

const LocationModal: React.FC<LocationModalProps> = ({ isOpen, onClose, location }) => {
    const { locations, addLocation, updateLocation } = useConfig();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [type, setType] = useState<LocationType>(LocationType.System);
    const [parentId, setParentId] = useState<string>('');
    const [isLoading, setIsLoading] = useState(false);
    const isEditing = !!location;

    // Seed/reset the user-editable form fields when the modal opens, or when the
    // selected location changes while open. The fields are edited afterward, so
    // they can't be derived during render — instead we re-seed during render via
    // the React-documented "adjust state on prop change" pattern, tracking the
    // previous (isOpen, location) pair. This fires on exactly the same
    // transitions the old [isOpen, location] effect did (open, and selection
    // change while open), and React re-renders before paint, so it is
    // behavior-equivalent to the effect-based reset.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevLocation, setPrevLocation] = useState(location);
    if (isOpen && (isOpen !== prevIsOpen || location !== prevLocation)) {
        setPrevIsOpen(isOpen);
        setPrevLocation(location);
        if (location) {
            setName(location.name);
            setType(location.type);
            setParentId(location.parent_id?.toString() || '');
        } else {
            setName('');
            setType(LocationType.System);
            setParentId('');
        }
        setIsLoading(false);
    } else if (isOpen !== prevIsOpen || location !== prevLocation) {
        // Keep the trackers in sync on transitions that don't re-seed (e.g. the
        // modal closing) so the next open is detected correctly.
        setPrevIsOpen(isOpen);
        setPrevLocation(location);
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;
        if (type !== LocationType.System && !parentId) {
            addToast("Validation Error", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: "A parent must be selected for this location type." });
            return;
        }

        setIsLoading(true);
        const locationData = {
            name: name.trim(),
            type,
            parent_id: parentId ? parseInt(parentId, 10) : null
        };

        try {
            if (isEditing && location) {
                await updateLocation({ id: location.id, ...locationData });
            } else {
                await addLocation(locationData);
            }
            onClose();
        } catch (err) {
            console.error("Failed to save location:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while saving the location. Please try again." });
            setIsLoading(false);
        }
    }, [name, type, parentId, isEditing, location, addLocation, updateLocation, onClose, addToast]);

    const availableParents = useMemo(() => {
        // Filter potential parents based on the selected type to maintain hierarchy logic
        switch (type) {
            case LocationType.Planet:
                return locations.filter(l => l.type === LocationType.System);
            case LocationType.Moon:
                return locations.filter(l => l.type === LocationType.Planet);
            case LocationType.Station:
                return locations.filter(l => l.type === LocationType.System || l.type === LocationType.Planet);
            case LocationType.Facility:
                return locations.filter(l => l.type === LocationType.Planet || l.type === LocationType.Moon || l.type === LocationType.Station);
            case LocationType.System:
            default:
                return [];
        }
    }, [type, locations]);

    const handleTypeChange = (newType: LocationType) => {
        setType(newType);
        setParentId('');
    };

    if (!isOpen) return null;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Location' : 'Create Location'}
            subtitle="Cartography Database"
            icon="fa-solid fa-map-location-dot"
            color="sky"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                {/* Body */}
                <div className="p-6 space-y-6">
                    <div>
                        <label htmlFor="locName" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Location Name</label>
                        <input
                            type="text"
                            id="locName"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g., Stanton or Grim HEX"
                            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all"
                            required
                            disabled={isLoading}
                        />
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                            <label htmlFor="locType" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Type</label>
                            <select
                                id="locType"
                                value={type}
                                onChange={(e) => handleTypeChange(e.target.value as LocationType)}
                                className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all"
                                disabled={isLoading}
                            >
                                {Object.values(LocationType).map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                        </div>
                        <div>
                            <label htmlFor="locParent" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Parent Location</label>
                            <select
                                id="locParent"
                                value={parentId}
                                onChange={(e) => setParentId(e.target.value)}
                                className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all disabled:bg-slate-900 disabled:opacity-50 disabled:cursor-not-allowed"
                                disabled={isLoading || type === LocationType.System}
                            >
                                <option value="">- Select Parent -</option>
                                {availableParents.map(parent => (
                                    <option key={parent.id} value={parent.id}>{parent.name}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex justify-end items-center p-6 bg-slate-900/50 border-t border-white/5 rounded-b-2xl shrink-0 gap-3">
                    <button type="button" onClick={onClose} className="px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors" disabled={isLoading}>Cancel</button>
                    <button
                        type="submit"
                        className="px-6 py-2.5 text-xs font-bold uppercase tracking-wider text-white bg-sky-600 rounded-lg hover:bg-sky-500 transition-all shadow-lg shadow-sky-900/20 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed disabled:shadow-none"
                        disabled={isLoading}
                    >
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : (isEditing ? 'Save Changes' : 'Create Location')}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default LocationModal;
