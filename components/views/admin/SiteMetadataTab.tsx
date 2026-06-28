
import React, { useState } from 'react';
import { useConfig } from '../../../contexts/ConfigContext';

import { OpenGraphConfig } from '../../../types';
import { TabPageHeader, SectionPanel } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';

const SiteMetadataTab: React.FC = () => {
    const { openGraphConfig, updateOpenGraphConfig } = useConfig();
    const { addToast } = useNotification();
    const [config, setConfig] = useState<OpenGraphConfig>(openGraphConfig);
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    // Track which URL most recently failed to load instead of a plain boolean so
    // that changing the URL automatically clears the error (no effect needed):
    // the stored URL no longer matches the current one, so the image re-attempts.
    const [erroredImageUrl, setErroredImageUrl] = useState<string | null>(null);
    const [erroredFaviconUrl, setErroredFaviconUrl] = useState<string | null>(null);
    const [erroredPwaIconUrl, setErroredPwaIconUrl] = useState<string | null>(null);

    // Re-sync the editable form when the source-of-truth config changes (e.g.
    // after a save elsewhere). Done during render via the previous-value pattern
    // instead of an effect to avoid the extra render the effect would cause.
    const [prevOpenGraphConfig, setPrevOpenGraphConfig] = useState(openGraphConfig);
    if (prevOpenGraphConfig !== openGraphConfig) {
        setPrevOpenGraphConfig(openGraphConfig);
        setConfig(openGraphConfig);
    }

    const imageError = erroredImageUrl === config.imageUrl;
    const faviconError = erroredFaviconUrl === config.faviconUrl;
    const pwaIconError = erroredPwaIconUrl === config.pwaIconUrl;

    const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
        setConfig(prev => ({ ...prev, [e.target.name]: e.target.value }));
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await updateOpenGraphConfig(config);
            setIsSaved(true);
            setTimeout(() => setIsSaved(false), 2000);
        } catch (err) {
            console.error(err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save site metadata settings. Please try again." });
        } finally {
            setIsSaving(false);
        }
    };
    
    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Site Metadata & Open Graph"
                icon="fa-solid fa-share-nodes"
                accent="indigo"
                subtitle="Configure the title, description, and images that identify this site."
            />

            <SectionPanel title="Open Graph & SEO" icon="fa-solid fa-share-nodes">
                <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
                    <div className="md:col-span-3 space-y-6">
                        <div>
                            <label htmlFor="title" className="block text-sm font-medium text-slate-300 mb-2">Meta Title</label>
                            <input
                                type="text"
                                id="title"
                                name="title"
                                value={config.title}
                                onChange={handleChange}
                                placeholder="e.g., My Organization Dashboard"
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white"
                            />
                        </div>
                        <div>
                            <label htmlFor="description" className="block text-sm font-medium text-slate-300 mb-2">Meta Description</label>
                            <textarea
                                id="description"
                                name="description"
                                value={config.description}
                                onChange={handleChange}
                                rows={3}
                                placeholder="e.g., An immersive portal for organization members..."
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white text-sm"
                            />
                        </div>
                        <div>
                            <label htmlFor="keywords" className="block text-sm font-medium text-slate-300 mb-2">Keywords (Comma Separated)</label>
                            <input
                                type="text"
                                id="keywords"
                                name="keywords"
                                value={config.keywords || ''}
                                onChange={handleChange}
                                placeholder="e.g., Star Citizen, Security, Org, Dashboard"
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white text-sm"
                            />
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label htmlFor="themeColor" className="block text-sm font-medium text-slate-300 mb-2">Theme Color</label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="color"
                                        id="themeColor"
                                        name="themeColor"
                                        value={config.themeColor || '#0f172a'}
                                        onChange={handleChange}
                                        className="bg-transparent border-none w-8 h-8 cursor-pointer p-0"
                                    />
                                    <input
                                        type="text"
                                        value={config.themeColor || '#0f172a'}
                                        onChange={handleChange}
                                        name="themeColor"
                                        className="flex-1 bg-slate-700/50 border border-slate-600 rounded-md p-2 text-white font-mono text-sm"
                                        placeholder="#0f172a"
                                    />
                                </div>
                            </div>
                            <div>
                                <label htmlFor="twitterCard" className="block text-sm font-medium text-slate-300 mb-2">Twitter Card Type</label>
                                <select 
                                    id="twitterCard" 
                                    name="twitterCard" 
                                    value={config.twitterCard || 'summary_large_image'} 
                                    onChange={handleChange}
                                    className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white text-sm"
                                >
                                    <option value="summary_large_image">Large Image (Recommended)</option>
                                    <option value="summary">Summary (Small)</option>
                                </select>
                            </div>
                        </div>

                         <div>
                            <label htmlFor="faviconUrl" className="block text-sm font-medium text-slate-300 mb-2">Favicon URL (Browser Tab)</label>
                             <div className="flex gap-4 items-center">
                                 <input
                                    type="text"
                                    id="faviconUrl"
                                    name="faviconUrl"
                                    value={config.faviconUrl || ''}
                                    onChange={handleChange}
                                    placeholder="https://example.com/favicon.png"
                                    className="flex-1 bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono text-sm"
                                />
                                <div className="w-10 h-10 shrink-0 bg-slate-800 rounded-sm border border-slate-700 flex items-center justify-center p-1">
                                    {config.faviconUrl && !faviconError ? (
                                        <img 
                                            src={config.faviconUrl} 
                                            alt="Favicon" 
                                            className="max-w-full max-h-full"
                                            onError={() => setErroredFaviconUrl(config.faviconUrl || null)}
                                        />
                                    ) : (
                                        <i className="fa-solid fa-globe text-slate-500"></i>
                                    )}
                                </div>
                             </div>
                             <p className="text-xs text-slate-500 mt-1">Recommended: 32x32px or 64x64px PNG/ICO</p>
                        </div>
                         <div>
                            <label htmlFor="pwaIconUrl" className="block text-sm font-medium text-slate-300 mb-2">App Icon URL (PWA / Mobile Home Screen)</label>
                             <div className="flex gap-4 items-center">
                                 <input
                                    type="text"
                                    id="pwaIconUrl"
                                    name="pwaIconUrl"
                                    value={config.pwaIconUrl || ''}
                                    onChange={handleChange}
                                    placeholder="https://example.com/icon-512.png"
                                    className="flex-1 bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono text-sm"
                                />
                                <div className="w-12 h-12 shrink-0 bg-slate-800 rounded-xl border border-slate-700 flex items-center justify-center p-1 overflow-hidden">
                                    {config.pwaIconUrl && !pwaIconError ? (
                                        <img 
                                            src={config.pwaIconUrl} 
                                            alt="App Icon" 
                                            className="w-full h-full object-cover"
                                            onError={() => setErroredPwaIconUrl(config.pwaIconUrl || null)}
                                        />
                                    ) : (
                                        <i className="fa-solid fa-mobile-screen text-slate-500 text-lg"></i>
                                    )}
                                </div>
                             </div>
                             <p className="text-xs text-slate-500 mt-1">
                                Used for "Add to Home Screen". Recommended: <strong>512x512px PNG</strong> (Maskable/Transparent).
                            </p>
                        </div>
                        <div>
                            <label htmlFor="imageUrl" className="block text-sm font-medium text-slate-300 mb-2">Open Graph Image URL (Social Share)</label>
                             <input
                                type="text"
                                id="imageUrl"
                                name="imageUrl"
                                value={config.imageUrl}
                                onChange={handleChange}
                                placeholder="https://example.com/social-image.png"
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono text-sm"
                            />
                        </div>
                    </div>
                    <div className="md:col-span-2">
                        <label className="block text-sm font-medium text-slate-300 mb-2">OG Image Preview</label>
                        <div className="w-full aspect-video bg-slate-800 rounded-md border border-slate-700 overflow-hidden flex items-center justify-center relative">
                           {config.imageUrl && !imageError ? (
                               <img 
                                   src={config.imageUrl} 
                                   alt="Open Graph Image Preview" 
                                   className="w-full h-full object-cover" 
                                   onError={() => setErroredImageUrl(config.imageUrl || null)}
                               />
                           ) : (
                               <div className="text-center p-4">
                                   <i className="fa-solid fa-image text-3xl text-slate-600 mb-2"></i>
                                   <p className="text-xs text-slate-500">
                                       {imageError ? 'Invalid Image URL' : 'No Image Set'}
                                   </p>
                                   <p className="text-[10px] text-slate-600 mt-2">Recommended: 1200x630px</p>
                               </div>
                           )}
                        </div>
                    </div>
                </div>

                <div className="mt-6 flex justify-end">
                    <button onClick={handleSave} disabled={isSaving || isSaved} className={`px-6 py-2 text-sm font-semibold text-white rounded-md border border-slate-600 transition-colors w-32 text-center ${isSaving ? 'bg-slate-800 cursor-wait' : isSaved ? 'bg-green-600 border-green-500' : 'bg-slate-700 hover:bg-slate-600'}`}>
                        {isSaving ? <i className="fa-solid fa-spinner animate-spin" /> : isSaved ? 'Saved!' : 'Save Settings'}
                    </button>
                </div>
            </SectionPanel>

            <div className="bg-amber-900/10 rounded-lg p-6 border border-amber-500/20">
                <h3 className="text-lg font-bold text-amber-500 flex items-center mb-2">
                    <i className="fa-solid fa-triangle-exclamation mr-2"></i>
                    Updates Not Reflecting?
                </h3>
                <p className="text-sm text-slate-300 mb-4">
                    Social media platforms (Discord, Twitter, LinkedIn) aggressively cache metadata. Updating settings here will update the internal system and PWA manifest immediately, but <strong>external links may take days to update unless you force a refresh</strong>.
                </p>
                <p className="text-sm text-slate-300 mb-2">Use the official validator tools to clear the cache for your link:</p>
                <div className="flex flex-wrap gap-3">
                    <a href="https://cards-dev.twitter.com/validator" target="_blank" rel="noopener noreferrer" className="text-xs bg-slate-800 hover:bg-slate-700 text-sky-400 border border-slate-600 px-3 py-2 rounded-sm flex items-center">
                        <i className="fa-brands fa-twitter mr-2"></i> Twitter Card Validator
                    </a>
                    <a href="https://www.linkedin.com/post-inspector/" target="_blank" rel="noopener noreferrer" className="text-xs bg-slate-800 hover:bg-slate-700 text-blue-400 border border-slate-600 px-3 py-2 rounded-sm flex items-center">
                        <i className="fa-brands fa-linkedin mr-2"></i> LinkedIn Inspector
                    </a>
                    <a href="https://developers.facebook.com/tools/debug/" target="_blank" rel="noopener noreferrer" className="text-xs bg-slate-800 hover:bg-slate-700 text-indigo-400 border border-slate-600 px-3 py-2 rounded-sm flex items-center">
                        <i className="fa-brands fa-facebook mr-2"></i> Facebook/Meta Debugger
                    </a>
                </div>
            </div>
        </div>
    );
};

export default SiteMetadataTab;
