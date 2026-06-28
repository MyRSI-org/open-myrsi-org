
import React, { useState, useEffect, useMemo } from 'react';
import { Role } from '../../../types';
import { useMembers } from '../../../contexts/MembersContext';

import { useNotification } from '../../../contexts/NotificationContext';

interface RoleDetailViewProps {
    roleId: number;
    onBack: () => void;
}

const RoleDetailView: React.FC<RoleDetailViewProps> = ({ roleId, onBack }) => {
    const { getRoleDetails, updateRolePermissions } = useMembers();
    const { addToast } = useNotification();
    const [role, setRole] = useState<Role | null>(null);
    const [allPermissions, setAllPermissions] = useState<any[]>([]);
    const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(() => new Set());
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [isClientRole, setIsClientRole] = useState(false);

    useEffect(() => {
        const fetchDetails = async () => {
            if (!getRoleDetails) {
                console.error("getRoleDetails function not implemented in context.");
                setIsLoading(false);
                return;
            }
            setIsLoading(true);
            try {
                const { role, allPermissions, clientRoleId } = await getRoleDetails(roleId);
                setRole(role);
                setAllPermissions(allPermissions);
                setSelectedPermissions(new Set(role.permissions));
                setIsClientRole(clientRoleId != null && role.id === clientRoleId);
            } catch (error) {
                console.error("Failed to fetch role details:", error);
                addToast("Load Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Could not load role details from the server." });
            } finally {
                setIsLoading(false);
            }
        };
        fetchDetails();
    }, [roleId, getRoleDetails, addToast]);

    const handlePermissionToggle = (permissionName: string) => {
        setSelectedPermissions(prev => {
            const newSet = new Set(prev);
            if (newSet.has(permissionName)) {
                newSet.delete(permissionName);
            } else {
                newSet.add(permissionName);
            }
            return newSet;
        });
    };

    const handleSave = async () => {
        if (!role || !updateRolePermissions) return;
        setIsSaving(true);
        try {
            await updateRolePermissions(role.id, Array.from(selectedPermissions));
            addToast("Permissions Saved", <i className="fa-solid fa-check"></i>, "bg-green-500/10 text-green-400 border-green-500/50", { description: "Role permissions have been updated successfully." });
        } catch (error) {
            console.error("Failed to save permissions:", error);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while saving role permissions." });
        } finally {
            setIsSaving(false);
        }
    };
    
    const filteredPermissions = useMemo(() => {
        if (!searchTerm.trim()) return allPermissions;
        return allPermissions.filter(p => 
            p.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
            p.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
            p.category.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }, [allPermissions, searchTerm]);

    const groupedPermissions = useMemo(() => {
        return filteredPermissions.reduce((acc: Record<string, any[]>, p: any) => {
            const category = p.category || 'General';
            if (!acc[category]) {
                acc[category] = [];
            }
            acc[category].push(p);
            return acc;
        }, {} as Record<string, any[]>);
    }, [filteredPermissions]);

    if (isLoading) {
        return (
             <div className="flex flex-col items-center justify-center h-64 text-slate-500">
                <i className="fa-solid fa-circle-notch animate-spin text-4xl mb-4 opacity-50"></i>
                <p>Loading security profiles...</p>
            </div>
        );
    }

    if (!role) {
        return <div className="p-6 text-center text-red-400">Role not found.</div>;
    }

    const categories = Object.keys(groupedPermissions).sort();

    return (
        <div className="p-6 h-full flex flex-col">
            {/* Header */}
            <div className="flex justify-between items-start mb-6">
                <div>
                     <button onClick={onBack} className="flex items-center text-xs font-bold uppercase tracking-widest text-slate-500 hover:text-white transition-colors mb-2">
                        <i className="fa-solid fa-arrow-left mr-2" />
                        Back to Levels
                    </button>
                    <h1 className="text-3xl font-black text-white">{role.name}</h1>
                    <p className="text-slate-400 mt-1">{role.description || 'No description provided.'}</p>
                </div>
                <div className="flex items-center gap-4">
                     <div className="relative">
                        <i className="fa-solid fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
                        <input
                            type="text"
                            placeholder="Filter permissions..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="w-64 bg-slate-900/60 border border-slate-700 rounded-lg py-2.5 pl-10 pr-4 text-white placeholder:text-slate-500 focus:ring-1 focus:ring-slate-400/50 focus:border-slate-500 outline-hidden text-sm transition-all"
                        />
                    </div>
                    {!isClientRole && (
                        <button
                            onClick={handleSave}
                            disabled={isSaving}
                            className="bg-green-600 hover:bg-green-500 text-white font-bold py-2.5 px-6 rounded-lg shadow-lg shadow-green-900/20 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                        >
                            {isSaving ? <i className="fa-solid fa-spinner animate-spin mr-2"></i> : <i className="fa-solid fa-floppy-disk mr-2"></i>}
                            {isSaving ? 'Saving...' : 'Save Changes'}
                        </button>
                    )}
                </div>
            </div>

            {isClientRole && (
                <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 mb-4">
                    <i className="fa-solid fa-lock text-amber-400"></i>
                    <p className="text-amber-300 text-sm font-medium">
                        The Client role is a system role with a fixed permission set and cannot be modified.
                    </p>
                </div>
            )}

            {/* Content */}
            <div className="flex-1 bg-slate-900/40 rounded-xl border border-slate-700/50 overflow-hidden flex flex-col">
                <div className="overflow-y-auto custom-scrollbar p-6 space-y-8">
                     {categories.map(category => (
                        <div key={category} className="animate-fade-in">
                            <h3 className="text-sm font-black text-slate-300 uppercase tracking-widest border-b border-slate-700/50 pb-2 mb-4">
                                {category}
                            </h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                {(groupedPermissions[category] as any[]).map(p => {
                                    const isSelected = selectedPermissions.has(p.name);
                                    return (
                                        <label
                                            key={p.id}
                                            className={`flex items-start gap-3 p-3 rounded-lg border transition-all group ${
                                                isClientRole ? 'cursor-default opacity-70' : 'cursor-pointer'
                                            } ${
                                                isSelected
                                                ? 'bg-slate-600/30 border-slate-400/60'
                                                : 'bg-slate-800/40 border-slate-700/50 hover:bg-slate-800 hover:border-slate-600'
                                            }`}
                                        >
                                            <div className="pt-0.5">
                                                <input
                                                    type="checkbox"
                                                    checked={isSelected}
                                                    onChange={() => !isClientRole && handlePermissionToggle(p.name)}
                                                    disabled={isClientRole}
                                                    className="h-4 w-4 rounded-sm bg-slate-700 border-slate-500 text-slate-300 focus:ring-slate-400/50 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                                                />
                                            </div>
                                            <div>
                                                <p className={`text-sm font-bold transition-colors ${isSelected ? 'text-white' : 'text-slate-300 group-hover:text-white'}`}>
                                                    {p.description}
                                                </p>
                                                <p className="text-[10px] text-slate-500 font-mono mt-0.5">{p.name}</p>
                                            </div>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                     ))}
                     
                     {categories.length === 0 && (
                         <div className="text-center py-12 text-slate-500 italic">
                             No permissions match your filter.
                         </div>
                     )}
                </div>
            </div>
        </div>
    );
};

export default RoleDetailView;
