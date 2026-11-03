
import React, { useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { GovernmentType } from '../../../types';
import { useNotification } from '../../../contexts/NotificationContext';
import { useGovernment } from '../../../contexts/GovernmentContext';
import { TEMPLATE_APPLY_WARNING } from './governmentUiRules';

interface GovernmentSetupWizardProps {
    onComplete: () => void;
}

const TEMPLATE_OPTIONS: { type: GovernmentType; name: string; icon: string; description: string; color: string }[] = [
    { type: GovernmentType.MilitaryJunta, name: 'Military Junta', icon: 'fa-solid fa-helmet-safety', description: 'Supreme commander with an appointed advisory council. Direct chain of command.', color: 'red' },
    { type: GovernmentType.CorporateBoard, name: 'Corporate Board', icon: 'fa-solid fa-building', description: 'CEO leads the executive. Board of Directors elected by members.', color: 'blue' },
    { type: GovernmentType.DemocraticRepublic, name: 'Democratic Republic', icon: 'fa-solid fa-landmark-dome', description: 'Elected President, Senate legislature, and appointed judiciary.', color: 'sky' },
    { type: GovernmentType.ConstitutionalMonarchy, name: 'Constitutional Monarchy', icon: 'fa-solid fa-crown', description: 'Hereditary monarch with an elected parliament.', color: 'amber' },
    { type: GovernmentType.Westminster, name: 'Westminster Parliament', icon: 'fa-solid fa-landmark', description: 'Bicameral parliament with PM elected by the house. Proportional representation.', color: 'emerald' },
    { type: GovernmentType.Technocracy, name: 'Technocracy', icon: 'fa-solid fa-microchip', description: 'Merit-based council of experts. Competence over popularity.', color: 'purple' },
    { type: GovernmentType.PirateCode, name: 'Pirate Code', icon: 'fa-solid fa-skull-crossbones', description: 'Captain elected by the crew. Quartermaster keeps order.', color: 'orange' },
    { type: GovernmentType.Custom, name: 'Custom', icon: 'fa-solid fa-puzzle-piece', description: 'Start from scratch. Build your own branches and positions.', color: 'slate' },
];

const colorMap: Record<string, string> = {
    red: 'border-red-500/30 hover:border-red-500/50 hover:bg-red-500/5',
    blue: 'border-blue-500/30 hover:border-blue-500/50 hover:bg-blue-500/5',
    sky: 'border-sky-500/30 hover:border-sky-500/50 hover:bg-sky-500/5',
    amber: 'border-amber-500/30 hover:border-amber-500/50 hover:bg-amber-500/5',
    emerald: 'border-emerald-500/30 hover:border-emerald-500/50 hover:bg-emerald-500/5',
    purple: 'border-purple-500/30 hover:border-purple-500/50 hover:bg-purple-500/5',
    orange: 'border-orange-500/30 hover:border-orange-500/50 hover:bg-orange-500/5',
    slate: 'border-slate-500/30 hover:border-slate-500/50 hover:bg-slate-500/5',
};

const selectedColorMap: Record<string, string> = {
    red: 'border-red-500 bg-red-500/10',
    blue: 'border-blue-500 bg-blue-500/10',
    sky: 'border-sky-500 bg-sky-500/10',
    amber: 'border-amber-500 bg-amber-500/10',
    emerald: 'border-emerald-500 bg-emerald-500/10',
    purple: 'border-purple-500 bg-purple-500/10',
    orange: 'border-orange-500 bg-orange-500/10',
    slate: 'border-slate-500 bg-slate-500/10',
};

const iconColorMap: Record<string, string> = {
    red: 'text-red-400',
    blue: 'text-blue-400',
    sky: 'text-sky-400',
    amber: 'text-amber-400',
    emerald: 'text-emerald-400',
    purple: 'text-purple-400',
    orange: 'text-orange-400',
    slate: 'text-slate-400',
};

const GovernmentSetupWizard: React.FC<GovernmentSetupWizardProps> = ({ onComplete }) => {
    const { rpcAction } = useData();
    const { addToast, confirm } = useNotification();
    const { governmentBranches, governmentPositions } = useGovernment();

    const [selectedType, setSelectedType] = useState<GovernmentType | null>(null);
    const [isApplying, setIsApplying] = useState(false);

    const handleApply = async () => {
        if (!selectedType) return;
        // "Restructure" reopens this wizard over an EXISTING government, and applying a
        // template there deletes every position (with its holders, elections and
        // legislation votes). Confirm first, with the same warning as the admin tab. A
        // first-time setup has nothing to lose; Custom only rewrites the config.
        const hasStructure = governmentBranches.length > 0 || governmentPositions.length > 0;
        if (selectedType !== GovernmentType.Custom && hasStructure) {
            const confirmed = await confirm({
                title: 'Apply Template',
                message: TEMPLATE_APPLY_WARNING,
                confirmText: 'Apply Template',
                variant: 'danger',
            });
            if (!confirmed) return;
        }
        setIsApplying(true);
        try {
            if (selectedType === GovernmentType.Custom) {
                await rpcAction('gov:upsert_config', {
                    config: { governmentType: 'custom', name: 'Government', description: 'Custom government structure' }
                });
            } else {
                await rpcAction('gov:apply_template', { templateType: selectedType });
            }
            addToast('Government Established', <i className="fa-solid fa-check" />, 'bg-emerald-500/10 text-emerald-400 border-emerald-500/50', { description: 'Your government structure has been created. You can customise it further from the admin panel.' });
            onComplete();
        } catch (err: any) {
            addToast('Setup Failed', <i className="fa-solid fa-circle-exclamation" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: err.message || 'Failed to create government structure.' });
        } finally {
            setIsApplying(false);
        }
    };

    return (
        <div className="bg-slate-900 border border-slate-700/50 rounded-xl p-6 max-w-4xl mx-auto">
            <div className="text-center mb-6">
                <div className="w-14 h-14 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mx-auto mb-3">
                    <i className="fa-solid fa-landmark text-2xl text-amber-400"></i>
                </div>
                <h2 className="text-xl font-bold text-white">Establish Government</h2>
                <p className="text-sm text-slate-400 mt-1">
                    Choose a governance template to get started. Everything can be customised after creation.
                </p>
            </div>

            {/* Template Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                {TEMPLATE_OPTIONS.map(opt => {
                    const isSelected = selectedType === opt.type;
                    return (
                        <button
                            key={opt.type}
                            onClick={() => setSelectedType(opt.type)}
                            className={`text-left p-4 rounded-lg border transition-all ${
                                isSelected ? selectedColorMap[opt.color] : colorMap[opt.color]
                            } ${isSelected ? 'ring-1 ring-white/10' : ''}`}
                        >
                            <i className={`${opt.icon} text-lg ${iconColorMap[opt.color]} mb-2 block`}></i>
                            <h3 className="text-sm font-bold text-white mb-1">{opt.name}</h3>
                            <p className="text-[11px] text-slate-400 leading-relaxed">{opt.description}</p>
                        </button>
                    );
                })}
            </div>

            {/* Apply Button */}
            <div className="flex justify-end">
                <button
                    onClick={handleApply}
                    disabled={!selectedType || isApplying}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    {isApplying ? (
                        <>
                            <div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full"></div>
                            Establishing...
                        </>
                    ) : (
                        <>
                            <i className="fa-solid fa-gavel"></i>
                            Establish Government
                        </>
                    )}
                </button>
            </div>
        </div>
    );
};

export default GovernmentSetupWizard;
