
import React, { useState, useMemo, useCallback } from 'react';
import { useFleet } from '../../../contexts/FleetContext';
import { PlatformShip } from '../../../types';
import { ShipCard } from './ShipCard';
import WindowFrame from '../../layout/WindowFrame';
import EmptyState from '../../shared/ui/EmptyState';

interface ShipCatalogBrowserProps {
    isOpen: boolean;
    onSelect: (ships: PlatformShip[]) => void;
    onClose: () => void;
}

const ShipCatalogBrowser: React.FC<ShipCatalogBrowserProps> = ({ isOpen, onSelect, onClose }) => {
    const { shipCatalog } = useFleet();
    const [search, setSearch] = useState('');
    const [filterManufacturer, setFilterManufacturer] = useState('');
    const [filterSize, setFilterSize] = useState('');
    const [filterRole, setFilterRole] = useState('');
    const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());

    const manufacturers = useMemo(() => {
        const set = new Set(shipCatalog.map(s => s.manufacturer));
        return Array.from(set).sort();
    }, [shipCatalog]);

    const sizes = useMemo(() => {
        const set = new Set(shipCatalog.map(s => s.size).filter(Boolean) as string[]);
        return Array.from(set).sort();
    }, [shipCatalog]);

    const roles = useMemo(() => {
        const set = new Set(shipCatalog.map(s => s.role).filter(Boolean) as string[]);
        return Array.from(set).sort();
    }, [shipCatalog]);

    const filtered = useMemo(() => {
        return shipCatalog.filter(s => {
            if (search && !s.name.toLowerCase().includes(search.toLowerCase()) && !s.manufacturer.toLowerCase().includes(search.toLowerCase())) return false;
            if (filterManufacturer && s.manufacturer !== filterManufacturer) return false;
            if (filterSize && s.size !== filterSize) return false;
            if (filterRole && s.role !== filterRole) return false;
            return true;
        });
    }, [shipCatalog, search, filterManufacturer, filterSize, filterRole]);

    const toggleSelect = useCallback((shipId: number) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(shipId)) next.delete(shipId);
            else next.add(shipId);
            return next;
        });
    }, []);

    const handleConfirm = useCallback(() => {
        const ships = shipCatalog.filter(s => selectedIds.has(s.id));
        if (ships.length > 0) onSelect(ships);
    }, [selectedIds, shipCatalog, onSelect]);

    const selectClass = 'bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-hidden focus:border-orange-500/40 focus:ring-1 focus:ring-orange-500/50 transition-all';

    return (
        <WindowFrame
            title="Ship Catalog"
            subtitle="Browse & Select Ships"
            icon="fa-solid fa-database"
            color="orange"
            width="max-w-5xl"
            isOpen={isOpen}
            onClose={onClose}
        >
            <div className="flex flex-col" style={{ maxHeight: 'calc(90vh - 60px)' }}>
                <div className="p-4 border-b border-white/5 bg-slate-900/50">
                    <div className="flex flex-col lg:flex-row gap-2 items-center">
                        <div className="relative flex-1 w-full">
                            <i className="fa-solid fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 text-xs"></i>
                            <input
                                type="search" value={search} onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search ships…"
                                className="w-full bg-slate-900/60 text-white pl-12 pr-4 py-2.5 rounded-lg border border-slate-700 outline-hidden placeholder:text-slate-500 font-mono text-sm focus:ring-1 focus:ring-orange-500/50 focus:border-orange-500/40 transition-all"
                            />
                        </div>
                        <select value={filterManufacturer} onChange={(e) => setFilterManufacturer(e.target.value)} className={selectClass}>
                            <option value="">All Manufacturers</option>
                            {manufacturers.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                        <select value={filterSize} onChange={(e) => setFilterSize(e.target.value)} className={selectClass}>
                            <option value="">All Sizes</option>
                            {sizes.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                        <select value={filterRole} onChange={(e) => setFilterRole(e.target.value)} className={selectClass}>
                            <option value="">All Roles</option>
                            {roles.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                    </div>
                    <p className="text-[10px] text-slate-500 mt-2 px-1 uppercase tracking-widest font-mono">{filtered.length} ships available · Click to select, then add</p>
                </div>

                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                    {shipCatalog.length === 0 ? (
                        <EmptyState
                            icon="fa-database"
                            accent="orange"
                            heading="Ship catalog is empty"
                            description="An administrator needs to sync the ship catalog from the Star Citizen Wiki."
                        />
                    ) : (
                        <>
                            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                                {filtered.map(ship => {
                                    const isSelected = selectedIds.has(ship.id);
                                    return (
                                        <div key={ship.id} className="relative">
                                            <ShipCard ship={ship} onClick={() => toggleSelect(ship.id)} />
                                            {isSelected && (
                                                <div className="absolute inset-0 rounded-xl ring-2 ring-orange-400 bg-orange-500/10 pointer-events-none" />
                                            )}
                                            <div
                                                onClick={(e) => { e.stopPropagation(); toggleSelect(ship.id); }}
                                                className={`absolute top-2 right-2 z-10 w-6 h-6 rounded-md border flex items-center justify-center cursor-pointer transition-all ${isSelected
                                                    ? 'bg-orange-500 border-orange-400 text-white'
                                                    : 'bg-slate-900/80 border-slate-600 text-transparent hover:border-orange-400'
                                                    }`}
                                            >
                                                <i className="fa-solid fa-check text-xs"></i>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            {filtered.length === 0 && (
                                <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 mt-4">
                                    <EmptyState
                                        icon="fa-filter"
                                        accent="orange"
                                        heading="No ships match your filters"
                                        description="Try clearing filters or adjusting the search."
                                        compact
                                    />
                                </div>
                            )}
                        </>
                    )}
                </div>

                <div className="flex items-center justify-between p-4 border-t border-white/5 bg-slate-900/50 rounded-b-xl">
                    <div className="text-sm text-slate-400">
                        {selectedIds.size > 0 ? (
                            <>
                                <span className="text-orange-300 font-bold">{selectedIds.size}</span> ship{selectedIds.size !== 1 ? 's' : ''} selected
                                <button onClick={() => setSelectedIds(new Set())} className="ml-3 text-xs text-slate-500 hover:text-white underline uppercase tracking-widest">Clear</button>
                            </>
                        ) : (
                            <span className="text-slate-500 text-xs uppercase tracking-widest font-mono">Click ships to select</span>
                        )}
                    </div>
                    <div className="flex gap-3">
                        <button onClick={onClose} className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-white transition-colors">
                            Cancel
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={selectedIds.size === 0}
                            className="flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest text-white bg-orange-600 hover:bg-orange-500 border border-orange-500/40 rounded-lg shadow-lg shadow-orange-900/30 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <i className="fa-solid fa-plus"></i>Add {selectedIds.size > 0 ? selectedIds.size : ''} Ship{selectedIds.size !== 1 ? 's' : ''}
                        </button>
                    </div>
                </div>
            </div>
        </WindowFrame>
    );
};

export default ShipCatalogBrowser;
