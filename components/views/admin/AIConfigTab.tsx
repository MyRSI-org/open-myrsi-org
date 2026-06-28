
import React, { useState } from 'react';
import { useConfig } from '../../../contexts/ConfigContext';

import { AIConfig } from '../../../types';
import { TabPageHeader, SectionPanel } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';

const AIConfigTab: React.FC = () => {
    const { aiConfig, updateAIConfig } = useConfig();
    const { addToast } = useNotification();
    const [config, setConfig] = useState<AIConfig>({ enabled: false, model: 'gemini-2.5-flash' });
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);

    // Sync the locally-editable config from the external ConfigContext store
    // whenever the server snapshot (aiConfig) changes. Done during render via
    // the React "adjust state during render" pattern with a previous-value
    // tracker on the aiConfig identity, instead of a synchronous set-in-effect.
    // The merge is identical to the old effect ({...prev, ...aiConfig}): server
    // fields overlay the current local config, preserving any local-only fields.
    // prevAiConfig starts at null (aiConfig is never null) so the merge also
    // runs on first render, matching the old mount-time effect.
    const [prevAiConfig, setPrevAiConfig] = useState<AIConfig | null>(null);
    if (aiConfig !== prevAiConfig) {
        setPrevAiConfig(aiConfig);
        if (aiConfig) {
            setConfig(prev => ({
                ...prev,
                ...aiConfig
            }));
        }
    }

    const handleSave = async () => {
        setIsSaving(true);
        try {
            await updateAIConfig(config);
            setIsSaved(true);
            setTimeout(() => setIsSaved(false), 2000);
        } catch (err) {
            console.error(err);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save AI settings." });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="AI Integration Settings"
                icon="fa-solid fa-robot"
                accent="purple"
                subtitle="Configure the integration with Google Gemini for automated intelligence summaries."
            />

            <SectionPanel title="Gemini Configuration" icon="fa-solid fa-robot">
                <div className="space-y-6 max-w-xl">
                    <div className="flex items-center justify-between p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                        <div>
                            <h3 className="font-medium text-white">Enable AI Features</h3>
                            <p className="text-xs text-slate-400">Allow the system to generate dossier summaries using Gemini.</p>
                        </div>
                        <button
                            onClick={() => setConfig(prev => ({ ...prev, enabled: !prev.enabled }))}
                            className={`w-12 h-6 rounded-full p-1 transition-colors duration-200 ease-in-out ${config.enabled ? 'bg-purple-600' : 'bg-slate-600'}`}
                        >
                            <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform duration-200 ease-in-out ${config.enabled ? 'translate-x-6' : 'translate-x-0'}`}></div>
                        </button>
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-slate-300 mb-2 uppercase tracking-wider">Tactical Model Selection</label>
                        <select
                            value={config.model}
                            onChange={(e) => setConfig(prev => ({ ...prev, model: e.target.value }))}
                            className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-hidden font-mono text-sm"
                            disabled={!config.enabled}
                        >
                            <option value="gemini-2.5-flash">Gemini 2.5 Flash (Recommended - Fast)</option>
                            <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite (Highest Quota)</option>
                            <option value="gemini-2.5-pro">Gemini 2.5 Pro (High Reasoning - Low Quota)</option>
                        </select>
                        <div className="mt-4 p-3 bg-black/40 rounded-sm border border-slate-800 text-[10px] text-slate-500 leading-relaxed uppercase tracking-widest">
                            <i className="fa-solid fa-circle-info mr-2 text-slate-400"></i>
                            Flash models provide up to 15 RPM on the free tier. Pro models are restricted to 2 RPM.
                            Switch to <span className="text-white">Flash-Lite</span> if you continue to encounter quota errors.
                        </div>
                    </div>

                    <div className="p-4 bg-slate-800/50 rounded-lg border border-slate-700">
                        <div className="flex items-center gap-2 mb-1">
                            <i className="fa-solid fa-key text-purple-400 text-xs"></i>
                            <h3 className="font-medium text-white text-sm">API Key</h3>
                        </div>
                        <p className="text-xs text-slate-400">Set the Gemini API key via the <code className="text-[10px] bg-slate-900 px-1 py-0.5 rounded-sm text-slate-300">GEMINI_API_KEY</code> variable in your server's <code className="text-[10px] bg-slate-900 px-1 py-0.5 rounded-sm text-slate-300">.env</code> file. It is encrypted at rest and never exposed to the browser.</p>
                    </div>

                    <div className="flex justify-end pt-4">
                        <button
                            onClick={handleSave}
                            disabled={isSaving || isSaved}
                            className={`px-6 py-2 text-xs font-black uppercase tracking-widest text-white rounded-lg transition-all w-40 text-center shadow-lg ${isSaving ? 'bg-purple-800 cursor-wait' : isSaved ? 'bg-green-600' : 'bg-purple-600 hover:bg-purple-700 shadow-purple-900/20'}`}
                        >
                            {isSaving ? <i className="fa-solid fa-spinner animate-spin" /> : isSaved ? 'Protocol Saved' : 'Commit Config'}
                        </button>
                    </div>
                </div>
            </SectionPanel>
        </div>
    );
};

export default AIConfigTab;
