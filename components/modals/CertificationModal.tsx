
import React, { useState, useCallback } from 'react';
import { Certification } from '../../types';
import { useMembers } from '../../contexts/MembersContext';

import WindowFrame from '../layout/WindowFrame';
import AwardIconInput from '../common/AwardIconInput';
import { useNotification } from '../../contexts/NotificationContext';

interface CertificationModalProps {
    isOpen: boolean;
    onClose: () => void;
    certification?: Certification;
}

const CertificationModal: React.FC<CertificationModalProps> = ({ isOpen, onClose, certification }) => {
    const { addCertification, updateCertification } = useMembers();
    const { addToast } = useNotification();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [icon, setIcon] = useState('');
    const [imageUrl, setImageUrl] = useState('');
    const [iconMode, setIconMode] = useState<'fa' | 'url'>('fa');
    const [isLoading, setIsLoading] = useState(false);
    const isEditing = !!certification;

    // Re-seed the editable form when the modal opens or the selected certification changes
    // (React's "adjust state during render" pattern). Tracking prevIsOpen/prevCert reproduces
    // the old [isOpen, certification] effect: seed only while open, on open or cert change.
    // Fields stay user-editable afterward, so they cannot be derived during render. React
    // re-renders before paint, making this behavior-equivalent to the effect-reset.
    const [prevIsOpen, setPrevIsOpen] = useState(false);
    const [prevCert, setPrevCert] = useState(certification);
    if (isOpen && (isOpen !== prevIsOpen || certification !== prevCert)) {
        setPrevIsOpen(isOpen);
        setPrevCert(certification);
        if (certification) {
            setName(certification.name);
            setDescription(certification.description || '');
            setIcon(certification.icon || '');
            setImageUrl(certification.imageUrl || '');
            setIconMode(certification.imageUrl ? 'url' : 'fa');
        } else {
            setName('');
            setDescription('');
            setIcon('');
            setImageUrl('');
            setIconMode('fa');
        }
        setIsLoading(false);
    } else if (isOpen !== prevIsOpen) {
        // Keep the open-tracker in sync across a close so the next open re-seeds.
        setPrevIsOpen(isOpen);
    }

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim()) return;

        setIsLoading(true);
        const certData = {
            name: name.trim(),
            description: description.trim() || null,
            icon: iconMode === 'fa' ? (icon.trim() || null) : null,
            imageUrl: iconMode === 'url' ? (imageUrl.trim() || null) : null,
        };

        try {
            if (isEditing && certification) {
                await updateCertification({ ...certification, ...certData });
            } else {
                await addCertification(certData);
            }
            onClose();
        } catch (err) {
            console.error("Failed to save certification:", err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "An error occurred while saving the certification. Please try again." });
            setIsLoading(false);
        }
    }, [name, description, icon, imageUrl, iconMode, isEditing, certification, addCertification, updateCertification, onClose, addToast]);

    if (!isOpen) return null;

    return (
        <WindowFrame
            isOpen={isOpen}
            onClose={onClose}
            title={isEditing ? 'Edit Certification' : 'Create Certification'}
            subtitle="Credentials Management"
            icon="fa-solid fa-certificate"
            color="sky"
            width="max-w-lg"
        >
            <form onSubmit={handleSubmit} className="flex flex-col h-full">
                {/* Body */}
                <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar flex-1">
                    <div>
                        <label htmlFor="certName" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Certification Name</label>
                        <input
                            type="text"
                            id="certName"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g., Basic Flight Certification"
                            className="w-full bg-slate-950/50 border border-slate-700 rounded-lg p-3 text-white focus:ring-1 focus:ring-sky-500 focus:border-sky-500 outline-hidden transition-all"
                            required
                            disabled={isLoading}
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Icon (Optional)</label>
                        <AwardIconInput
                            icon={icon}
                            onIconChange={setIcon}
                            imageUrl={imageUrl}
                            onImageUrlChange={setImageUrl}
                            mode={iconMode}
                            onModeChange={setIconMode}
                            fallbackIcon="fa-solid fa-certificate"
                            accentClass="text-sky-400"
                            disabled={isLoading}
                            iconPlaceholder="e.g., fa-solid fa-user-astronaut"
                        />
                    </div>
                    <div>
                        <label htmlFor="certDescription" className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Description (Optional)</label>
                        <textarea
                            id="certDescription"
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            rows={3}
                            placeholder="e.g., Passed basic flight and combat maneuvers training."
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
                        {isLoading ? <i className="fa-solid fa-spinner animate-spin"></i> : (isEditing ? 'Save Changes' : 'Create Certification')}
                    </button>
                </div>
            </form>
        </WindowFrame>
    );
};

export default CertificationModal;
