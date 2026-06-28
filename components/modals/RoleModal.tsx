
import React, { useState, useCallback, useMemo } from 'react';
import { Role } from '../../types';
import { useMembers } from '../../contexts/MembersContext';

import WindowFrame from '../layout/WindowFrame';
import { useNotification } from '../../contexts/NotificationContext';

interface RoleModalProps {
    isOpen: boolean;
    onClose: () => void;
    role?: Role;
}

const RoleModal: React.FC<RoleModalProps> = ({ isOpen, onClose, role }) => {
    const { addRole, updateRole, roles } = useMembers();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const isEditing = !!role;

    // Determine if this is a system role (Client/Member/Dispatcher/Admin) that shouldn't be renamed
    const isDefaultRole = useMemo(() => {
        if (!isEditing || !role) return false;
        if (role.is_system === true) return true;
        // Fallback for orgs without is_system flag: check if it's one of the first 4 roles by ID
        const sorted = [...roles].sort((a, b) => a.id - b.id);
        const first4Ids = sorted.slice(0, 4).map(r => r.id);
        return first4Ids.includes(role.id);
    }, [isEditing, role, roles]);

    // Seed/reset the editable form when the modal opens or the selected role
    // changes while open. Adjusts state during render (React's documented
    // pattern) instead of in an effect; the fields must stay user-editable so
    // they cannot be derived during render.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevRole, setPrevRole] = useState(role);
    if (isOpen !== prevIsOpen || role !== prevRole) {
        setPrevIsOpen(isOpen);
        setPrevRole(role);
        if (isOpen) {
            if (role) {
                setName(role.name);
                setDescription(role.description || '');
            } else {
                setName('');
                setDescription('');
            }
            setIsLoading(false);
        }
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setIsLoading(true);
        const roleData = {
            name: name.trim(),
            description: description.trim(),
        };

        try {
            if (isEditing && role) {
                await updateRole({ ...role, ...roleData });
            } else {
                await addRole(roleData);
            }
            onClose();
        } catch (err) {
            console.error("Failed to save role:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while saving the role. Please try again." });
            setIsLoading(false);
        }
    }, [name, description, isEditing, role, addRole, updateRole, onClose, addToast]);

    if (!isOpen) return null;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit System Role' : 'Create System Role'}
            subtitle="Permission Level Configuration"
            icon="fa-solid fa-shield-halved"
            color="sky"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                {/* Body */}
                <div className="p-6 space-y-6">
                    <div>
                        <label htmlFor="roleName" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">System Role Name</label>
                        <input
                            type="text"
                            id="roleName"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            required
                            disabled={isLoading || isDefaultRole}
                        />
                        {isDefaultRole && <p className="text-[10px] text-slate-500 mt-1 font-bold flex items-center"><i className="fa-solid fa-lock mr-1"></i> Default system roles cannot be renamed.</p>}
                    </div>
                    <div>
                        <label htmlFor="roleDescription" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description</label>
                        <textarea
                            id="roleDescription"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={4}
                            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all resize-none"
                            disabled={isLoading}
                        />
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
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : (isEditing ? 'Save Changes' : 'Create Role')}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default RoleModal;
