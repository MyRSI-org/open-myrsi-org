
import React, { useState } from 'react';
import { useConfig } from '../../../contexts/ConfigContext';
import { BrandingConfig } from '../../../types';
import { TabPageHeader, SectionPanel } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';

const SOUND_FIELDS = ['bootSoundUrl', 'newRequestSoundUrl', 'assignmentSoundUrl', 'eamSoundUrl', 'radioMicCueUrl', 'radioSquelchUrl'] as const;

const inputCls = "w-full bg-slate-900/60 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:ring-1 focus:ring-slate-400/50 focus:border-slate-500 outline-hidden transition-all";
const inputMonoCls = inputCls + " font-mono";

const OrganizationIdentityTab: React.FC = () => {
    const { brandingConfig, updateBrandingConfig, updateSystemConfig } = useConfig();
    const { addToast } = useNotification();
    const [config, setConfig] = useState<BrandingConfig>(brandingConfig);
    const [systemAppUrl] = useState(typeof window !== 'undefined' ? window.location.origin : '');
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);

    // Re-sync local editable config when the upstream branding config changes,
    // using the "adjust state during render" pattern instead of an effect.
    const [prevBrandingConfig, setPrevBrandingConfig] = useState<BrandingConfig>(brandingConfig);
    if (prevBrandingConfig !== brandingConfig) {
        setPrevBrandingConfig(brandingConfig);
        setConfig(brandingConfig);
    }

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value, type } = e.target;
        setConfig(prev => ({
            ...prev,
            [name]: type === 'number' ? (value === '' ? undefined : Number(value)) : value
        }));
    };

    const handleSoundChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        if (value && !value.match(/^https?:\/\/.+\.mp3(\?.*)?$/i)) {
            e.target.setCustomValidity('URL must point to an .mp3 file');
        } else {
            e.target.setCustomValidity('');
        }
        setConfig(prev => ({ ...prev, [name]: value }));
    };

    const handleSave = async () => {
        setIsSaving(true);
        for (const field of SOUND_FIELDS) {
            const val = (config as any)[field];
            if (val && !val.match(/^https?:\/\/.+\.mp3(\?.*)?$/i)) {
                addToast("Invalid Sound URL", <i className="fa-solid fa-triangle-exclamation"></i>, "bg-amber-500/10 text-amber-400 border-amber-500/50", { description: `The URL for ${field} is invalid. Only .mp3 files are accepted.` });
                setIsSaving(false);
                return;
            }
        }
        try {
            await updateBrandingConfig(config);
            if (systemAppUrl) {
                await updateSystemConfig(systemAppUrl);
            }
            setIsSaved(true);
            setTimeout(() => setIsSaved(false), 2000);
        } catch (err) {
            console.error(err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save organization identity." });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Organization Identity"
                icon="fa-solid fa-palette"
                accent="purple"
                subtitle="Name, logo, login screen, duty defaults, and audio cues."
            />

            <SectionPanel title="Visual Identity" icon="fa-solid fa-image">
                <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
                    <div className="md:col-span-3 space-y-4">
                        <div>
                            <label htmlFor="name" className="block text-sm font-medium text-slate-300 mb-2">Organization Name</label>
                            <input type="text" id="name" name="name" value={config.name} onChange={handleChange} className={inputCls} />
                        </div>
                        <div>
                            <label htmlFor="iconUrl" className="block text-sm font-medium text-slate-300 mb-2">Logo URL</label>
                            <input type="text" id="iconUrl" name="iconUrl" value={config.iconUrl} onChange={handleChange} className={inputMonoCls} />
                        </div>
                    </div>
                    <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-slate-300 mb-2 text-center">Live Identity Preview</label>
                        <div className="w-full p-6 bg-slate-950/60 rounded-xl border border-slate-700 flex flex-col items-center justify-center space-y-4 min-h-[140px] shadow-inner">
                            <img src={config.iconUrl} alt="Icon Preview" className="h-16 w-16 drop-shadow-lg" onError={(e) => (e.currentTarget.style.display = 'none')} onLoad={(e) => (e.currentTarget.style.display = 'block')} />
                            <span className="text-2xl font-black text-white tracking-[0.2em] uppercase text-center">{config.name}</span>
                        </div>
                    </div>
                </div>
            </SectionPanel>

            <SectionPanel title="Login Screen" icon="fa-solid fa-right-to-bracket">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label htmlFor="loginTitle" className="block text-sm font-medium text-slate-300 mb-2">Welcome Title</label>
                        <input type="text" id="loginTitle" name="loginTitle" value={config.loginTitle || ''} onChange={handleChange} placeholder="Operations Dashboard" className={inputCls} />
                    </div>
                    <div>
                        <label htmlFor="loginSubtitle" className="block text-sm font-medium text-slate-300 mb-2">Welcome Subtitle</label>
                        <input type="text" id="loginSubtitle" name="loginSubtitle" value={config.loginSubtitle || ''} onChange={handleChange} placeholder="Please log in to continue." className={inputCls} />
                    </div>
                </div>
            </SectionPanel>

            <SectionPanel title="Operational Protocols" icon="fa-solid fa-clock">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Auto-Off Duty Timeout (Minutes)</label>
                        <input type="number" name="dutyTimeoutMinutes" value={config.dutyTimeoutMinutes || ''} onChange={handleChange} className={inputMonoCls} min="5" />
                        <p className="text-[10px] text-slate-500 mt-1 uppercase font-bold">Recommended: 30–60 Minutes</p>
                    </div>
                </div>
            </SectionPanel>

            <SectionPanel title="Audio Environment" icon="fa-solid fa-volume-high" note="All sound URLs must link to .mp3 files (e.g. https://example.com/sound.mp3)">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Boot Sound URL</label>
                        <input type="url" name="bootSoundUrl" value={config.bootSoundUrl || ''} onChange={handleSoundChange} placeholder="https://example.com/boot.mp3" className={inputMonoCls} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">New Request Sound URL</label>
                        <input type="url" name="newRequestSoundUrl" value={config.newRequestSoundUrl || ''} onChange={handleSoundChange} placeholder="https://example.com/request.mp3" className={inputMonoCls} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Assignment Sound URL</label>
                        <input type="url" name="assignmentSoundUrl" value={config.assignmentSoundUrl || ''} onChange={handleSoundChange} placeholder="https://example.com/assign.mp3" className={inputMonoCls} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">EAM Alert Sound URL</label>
                        <input type="url" name="eamSoundUrl" value={config.eamSoundUrl || ''} onChange={handleSoundChange} placeholder="https://example.com/eam.mp3" className={inputMonoCls} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Radio Mic Click URL</label>
                        <input type="url" name="radioMicCueUrl" value={config.radioMicCueUrl || ''} onChange={handleSoundChange} placeholder="https://example.com/mic-cue.mp3" className={inputMonoCls} />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Radio Squelch URL</label>
                        <input type="url" name="radioSquelchUrl" value={config.radioSquelchUrl || ''} onChange={handleSoundChange} placeholder="https://example.com/squelch.mp3" className={inputMonoCls} />
                    </div>
                </div>
            </SectionPanel>

            <div className="flex justify-end pt-4">
                <button
                    onClick={handleSave}
                    disabled={isSaving || isSaved}
                    className={`px-8 py-3 text-xs font-black uppercase tracking-widest rounded-lg border transition-all shadow-lg transform active:scale-95 ${isSaving
                        ? 'bg-slate-800 border-slate-700 text-slate-400 cursor-wait'
                        : isSaved
                            ? 'bg-green-500/10 border-green-500/40 text-green-300'
                            : 'bg-slate-700 hover:bg-slate-600 border-slate-600 text-white'}`}
                >
                    {isSaving ? <><i className="fa-solid fa-spinner animate-spin mr-2" />Saving</> : isSaved ? <><i className="fa-solid fa-check mr-2" />Saved</> : 'Save Identity Settings'}
                </button>
            </div>
        </div>
    );
};

export default OrganizationIdentityTab;
