
import React, { useState } from 'react';
import { useConfig } from '../../../contexts/ConfigContext';

import { HeroCardConfig } from '../../../types';
import { sanitizeImageUrl } from '../../../lib/imageUrl';
import { TabPageHeader, SectionPanel } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';

const ClientSettingsTab: React.FC = () => {
    const { heroCardConfig, updateHeroCardConfig } = useConfig();
    const { addToast } = useNotification();
    const [config, setConfig] = useState<HeroCardConfig>(heroCardConfig);
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);

    // Re-seed the local editable form when the canonical config from context changes
    // (e.g. after a save or an external update). config is user-editable local state, so
    // it cannot be derived during render without discarding in-progress edits. Using the
    // adjust-state-during-render pattern (previous-value tracker) rather than an effect:
    // re-seeds on the exact same condition (heroCardConfig reference change) with no extra
    // commit. (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
    const [prevHeroCardConfig, setPrevHeroCardConfig] = useState(heroCardConfig);
    if (heroCardConfig !== prevHeroCardConfig) {
        setPrevHeroCardConfig(heroCardConfig);
        setConfig(heroCardConfig);
    }

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        setConfig(prev => ({...prev, [e.target.name]: e.target.value }));
    };

    const sanitizedPreviewUrl = sanitizeImageUrl(config.backgroundImageUrl);
    const previewStyle: React.CSSProperties | undefined = sanitizedPreviewUrl
        ? { backgroundImage: `url("${sanitizedPreviewUrl.replace(/"/g, '%22')}")` }
        : undefined;

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await updateHeroCardConfig(config);
            setIsSaved(true);
            setTimeout(() => setIsSaved(false), 2000);
        } catch (err) {
            console.error(err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save client dashboard settings. Please try again." });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Client Dashboard Settings"
                icon="fa-solid fa-gear"
                accent="sky"
                subtitle="Configure the hero card shown to users with the Client role."
            />

            <SectionPanel title="Hero Card" icon="fa-solid fa-image">
                <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
                    <div className="md:col-span-3 space-y-6">
                        <div>
                            <label htmlFor="backgroundImageUrl" className="block text-sm font-medium text-slate-300 mb-2">Background Image URL</label>
                            <input
                                type="text"
                                id="backgroundImageUrl"
                                name="backgroundImageUrl"
                                value={config.backgroundImageUrl}
                                onChange={handleChange}
                                placeholder="https://..."
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono"
                            />
                        </div>
                        <div>
                            <label htmlFor="discordUrl" className="block text-sm font-medium text-slate-300 mb-2">Discord Invite URL</label>
                            <input
                                type="text"
                                id="discordUrl"
                                name="discordUrl"
                                value={config.discordUrl}
                                onChange={handleChange}
                                placeholder="https://discord.gg/..."
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono"
                            />
                        </div>
                        <div>
                            <label htmlFor="organizationUrl" className="block text-sm font-medium text-slate-300 mb-2">Organization URL</label>
                            <input
                                type="text"
                                id="organizationUrl"
                                name="organizationUrl"
                                value={config.organizationUrl}
                                onChange={handleChange}
                                placeholder="https://robertsspaceindustries.com/orgs/..."
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono"
                            />
                        </div>
                         <div>
                            <label htmlFor="title" className="block text-sm font-medium text-slate-300 mb-2">Card Title</label>
                            <input
                                type="text"
                                id="title"
                                name="title"
                                value={config.title}
                                onChange={handleChange}
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white"
                            />
                        </div>
                        <div>
                            <label htmlFor="subtitle" className="block text-sm font-medium text-slate-300 mb-2">Card Subtitle</label>
                            <textarea
                                id="subtitle"
                                name="subtitle"
                                value={config.subtitle}
                                onChange={handleChange}
                                rows={5}
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white text-sm"
                            />
                        </div>
                    </div>
                    <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-slate-300 mb-2">Live Preview</label>
                        <div
                            className="w-full aspect-video min-h-[280px] rounded-lg border border-slate-700 bg-cover bg-center flex flex-col justify-between p-4 text-white relative overflow-hidden"
                            style={previewStyle}
                        >
                            <div className="absolute inset-0 bg-slate-900/60"></div>
                            <div className="relative z-10">
                                <h2 className="text-xl font-bold">{config.title}</h2>
                                <p className="text-slate-300 mt-1 text-xs">{config.subtitle}</p>
                            </div>
                            <div className="relative z-10 space-y-2">
                                <button className="flex items-center justify-center w-full bg-[#5865F2] text-white font-semibold px-4 py-2 rounded-md text-sm">
                                    <i className="fa-brands fa-discord h-4 w-4 mr-2" />
                                    Join our Discord
                                </button>
                                <button className="flex items-center justify-center w-full bg-slate-700/80 text-slate-200 font-semibold px-4 py-2 rounded-md text-sm">
                                    Join the Organization
                                    <i className="fa-solid fa-arrow-up-right-from-square h-3 w-3 ml-2" />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mt-6 flex justify-end">
                    <button onClick={handleSave} disabled={isSaving || isSaved} className={`px-6 py-2 text-sm font-semibold text-white rounded-md border border-slate-600 transition-colors w-32 text-center ${isSaving ? 'bg-slate-800 cursor-wait' : isSaved ? 'bg-green-600 border-green-500' : 'bg-slate-700 hover:bg-slate-600'}`}>
                        {isSaving ? <i className="fa-solid fa-spinner animate-spin" /> : isSaved ? 'Saved!' : 'Save Settings'}
                    </button>
                </div>
            </SectionPanel>
        </div>
    );
};

export default ClientSettingsTab;
