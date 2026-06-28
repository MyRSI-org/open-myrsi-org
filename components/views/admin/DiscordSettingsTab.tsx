
import React, { useState, useEffect } from 'react';
import { useMembers } from '../../../contexts/MembersContext';
import { useConfig } from '../../../contexts/ConfigContext';

import { TabPageHeader } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';
import { useModalRegistry } from '../../../contexts/ModalRegistryContext';

type SubTab = 'channels' | 'mapping';

const DiscordSettingsTab: React.FC = () => {
    const {
        syncDiscordRoles,
        syncedDiscordRoles,
        ranks,
        roles,
        rankMappings,
        roleMappings,
        updateRankMapping,
        refreshDiscord,
    } = useMembers();
    const { discordConfig, updateDiscordConfig } = useConfig();
    const { addToast } = useNotification();
    const { setIsSyncUsersModalOpen } = useModalRegistry();

    const [activeTab, setActiveTab] = useState<SubTab>('channels');

    // The role-sync maps no longer ride the boot payload (the 'discord'
    // subset is admin:config:discord-gated) — fetch on mount.
    useEffect(() => { void refreshDiscord(); }, [refreshDiscord]);

    // --- Channel Settings State ---
    const [newRequestChannelId, setNewRequestChannelId] = useState('');
    const [intelChannelId, setIntelChannelId] = useState('');
    const [eamChannelId, setEamChannelId] = useState('');
    const [defaultOperationAnnounceChannelId, setDefaultOperationAnnounceChannelId] = useState('');
    const [configLoaded, setConfigLoaded] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);

    // Sync local state from discordConfig. Any referential change to discordConfig
    // means a fresh server snapshot, so flip configLoaded immediately rather than
    // gating on whether channel IDs are populated. The locally-editable channel fields
    // must not be derived during render (that would discard in-progress user edits), so
    // we re-seed them via the adjust-state-during-render pattern (previous-value tracker)
    // on the exact same condition and with the exact same values/guard as the old effect.
    // (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
    const [prevDiscordConfig, setPrevDiscordConfig] = useState<typeof discordConfig | null>(null);
    if (discordConfig && discordConfig !== prevDiscordConfig) {
        setPrevDiscordConfig(discordConfig);
        setNewRequestChannelId(discordConfig.newRequestChannelId || '');
        setIntelChannelId(discordConfig.intelChannelId || '');
        setEamChannelId(discordConfig.eamChannelId || '');
        setDefaultOperationAnnounceChannelId(discordConfig.defaultOperationAnnounceChannelId || '');
        setConfigLoaded(true);
    }

    // --- Role Mapping State ---
    const [isFetching, setIsFetching] = useState(false);

    // Filter to only assignable roles (non-Admin system roles + custom roles)
    // Admin role (4th system role) and Client role (1st) should not be assignable via Discord sync
    const systemRolesSorted = roles.filter(r => r.is_system).sort((a, b) => a.id - b.id);
    const adminRoleId = systemRolesSorted[systemRolesSorted.length - 1]?.id;
    const clientRoleId = systemRolesSorted[0]?.id;
    const assignableRoles = roles.filter(r =>
        r.id !== adminRoleId && r.id !== clientRoleId
    );

    const handleUpdateConfig = async () => {
        setIsSaving(true);
        try {
            await updateDiscordConfig({ newRequestChannelId, intelChannelId, eamChannelId, defaultOperationAnnounceChannelId });
            setIsSaved(true);
            setTimeout(() => setIsSaved(false), 2000);
        } catch (error) {
            console.error(error);
            addToast("Save Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: "Failed to save Discord configuration. Please check the console for details." });
        } finally {
            setIsSaving(false);
        }
    };

    const handleFetchRoles = async () => {
        setIsFetching(true);
        try {
            await syncDiscordRoles();
            addToast("Roles Fetched", <i className="fa-solid fa-check"></i>, "bg-emerald-500/10 text-emerald-400 border-emerald-500/50", { description: "Discord server roles synced successfully." });
        } catch (error: any) {
            console.error('[DiscordSettingsTab] Fetch roles failed:', error);
            addToast("Fetch Failed", <i className="fa-solid fa-xmark"></i>, "bg-red-500/10 text-red-400 border-red-500/50", { description: error?.message || "Failed to fetch Discord roles. Check that DISCORD_BOT_TOKEN and DISCORD_GUILD_ID are set in your server's .env file." });
        } finally {
            setIsFetching(false);
        }
    };

    const handleRankChange = (discordRoleId: string, newRankId: string) => {
        const currentRoleMapping = roleMappings[discordRoleId] || '';
        updateRankMapping(discordRoleId, newRankId, currentRoleMapping);
    };

    const handleRoleChange = (discordRoleId: string, newRoleId: string) => {
        const currentRankMapping = rankMappings[discordRoleId] || '';
        updateRankMapping(discordRoleId, currentRankMapping, newRoleId);
    };

    const tabs: { key: SubTab; label: string; icon: string }[] = [
        { key: 'channels', label: 'Channel Settings', icon: 'fa-solid fa-hashtag' },
        { key: 'mapping', label: 'Role Mapping', icon: 'fa-solid fa-arrows-rotate' },
    ];

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Discord Integration"
                icon="fa-brands fa-discord"
                accent="indigo"
                subtitle="Connect your Discord server for bot, channel routing, and role sync."
            />

            <div className="flex border-b border-slate-700/50 overflow-x-auto custom-scrollbar">
                {tabs.map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => setActiveTab(tab.key)}
                        className={`px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                            activeTab === tab.key
                                ? 'text-slate-100 border-slate-300'
                                : 'text-slate-400 border-transparent hover:text-slate-200 hover:border-slate-500'
                        }`}
                    >
                        <i className={`${tab.icon} mr-2`} />
                        {tab.label}
                    </button>
                ))}
            </div>

            {/* Discord Bot Configuration Warning */}
            {!discordConfig?.clientId && (
                <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-4 flex items-start gap-3">
                    <i className="fa-solid fa-triangle-exclamation text-amber-500 mt-0.5"></i>
                    <div>
                        <p className="text-sm font-bold text-amber-400">Discord Bot Not Configured</p>
                        <p className="text-xs text-slate-400 mt-1">
                            Discord integration requires bot credentials. Set <strong className="text-slate-300">DISCORD_CLIENT_ID</strong>, <strong className="text-slate-300">DISCORD_CLIENT_SECRET</strong>, <strong className="text-slate-300">DISCORD_BOT_TOKEN</strong>, and <strong className="text-slate-300">DISCORD_GUILD_ID</strong> in your server's <strong className="text-slate-300">.env</strong> file. Channel settings below will have no effect until the bot is set up.
                        </p>
                    </div>
                </div>
            )}

            {/* Channel Settings Tab */}
            {activeTab === 'channels' && (
                <div className="bg-slate-900/50 rounded-lg p-6 border border-slate-700/50">
                    <h2 className="text-xl text-white flex items-center mb-4">
                        <i className="fa-brands fa-discord h-6 w-6 mr-3 text-[#5865F2]" />
                        Discord Channel Configuration
                    </h2>

                    <div className="bg-[#5865F2]/10 border border-[#5865F2]/30 p-4 rounded-md mb-6 text-sm text-slate-300">
                        <p className="font-bold text-white mb-2"><i className="fa-solid fa-circle-info mr-2"></i>How to get Channel IDs:</p>
                        <ol className="list-decimal list-inside space-y-1 ml-2">
                            <li>Open Discord <strong>User Settings</strong> &gt; <strong>Advanced</strong>.</li>
                            <li>Enable <strong>Developer Mode</strong>.</li>
                            <li>Right-click the desired text channel in your server.</li>
                            <li>Click <strong>Copy Channel ID</strong> (e.g., 123456789012345678).</li>
                        </ol>
                        <p className="mt-2 text-xs text-slate-400">Do not use Webhook URLs. The system uses your configured Bot to post messages directly.</p>
                    </div>

                    <div className="grid grid-cols-1 gap-6">
                        <div>
                            <label htmlFor="newRequestChannelId" className="block text-sm font-medium text-slate-300 mb-2">New Request Channel ID</label>
                            <input
                                type="text"
                                id="newRequestChannelId"
                                name="newRequestChannelId"
                                value={newRequestChannelId}
                                onChange={e => setNewRequestChannelId(e.target.value)}
                                placeholder={configLoaded ? "e.g., 123456789012345678" : "Loading..."}
                                disabled={!configLoaded}
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono disabled:opacity-50"
                            />
                            <p className="text-xs text-slate-500 mt-1">Notifications for new Service Requests will be posted here.</p>
                        </div>
                        <div>
                            <label htmlFor="intelChannelId" className="block text-sm font-medium text-slate-300 mb-2">Intel Bulletin Channel ID</label>
                            <input
                                type="text"
                                id="intelChannelId"
                                name="intelChannelId"
                                value={intelChannelId}
                                onChange={e => setIntelChannelId(e.target.value)}
                                placeholder={configLoaded ? "e.g., 123456789012345678" : "Loading..."}
                                disabled={!configLoaded}
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono disabled:opacity-50"
                            />
                            <p className="text-xs text-slate-500 mt-1">New Intel Bulletins will be posted here as formatted embeds.</p>
                        </div>
                        <div>
                            <label htmlFor="eamChannelId" className="block text-sm font-medium text-slate-300 mb-2">EAM Broadcast Channel ID</label>
                            <input
                                type="text"
                                id="eamChannelId"
                                name="eamChannelId"
                                value={eamChannelId}
                                onChange={e => setEamChannelId(e.target.value)}
                                placeholder={configLoaded ? "e.g., 123456789012345678" : "Loading..."}
                                disabled={!configLoaded}
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono disabled:opacity-50"
                            />
                            <p className="text-xs text-slate-500 mt-1">Emergency Action Messages issued from the dashboard will be posted here as a high-priority embed with an @here mention.</p>
                        </div>
                        <div>
                            <label htmlFor="defaultOperationAnnounceChannelId" className="block text-sm font-medium text-slate-300 mb-2">Operation Announcement Channel ID <span className="text-slate-500 font-normal">(default)</span></label>
                            <input
                                type="text"
                                id="defaultOperationAnnounceChannelId"
                                name="defaultOperationAnnounceChannelId"
                                value={defaultOperationAnnounceChannelId}
                                onChange={e => setDefaultOperationAnnounceChannelId(e.target.value)}
                                placeholder={configLoaded ? "e.g., 123456789012345678" : "Loading..."}
                                disabled={!configLoaded}
                                className="w-full bg-slate-700/50 border border-slate-600 rounded-md p-2.5 text-white font-mono disabled:opacity-50"
                            />
                            <p className="text-xs text-slate-500 mt-1">Pre-selected in the operation create wizard's "Post Announcement Embed" picker. Per-op overrides win — use this to point everyday ops at the right channel without forcing it.</p>
                        </div>
                    </div>

                    <div className="mt-6 flex justify-end">
                        <button onClick={handleUpdateConfig} disabled={isSaving || !configLoaded} className="px-6 py-2 text-sm font-semibold text-white bg-slate-700 border border-slate-600 rounded-md hover:bg-slate-600 transition-colors disabled:bg-slate-800 disabled:cursor-not-allowed flex items-center">
                            {isSaving && <i className="fa-solid fa-spinner animate-spin mr-2"></i>}
                            {isSaved && <i className="fa-solid fa-check mr-2"></i>}
                            {isSaving ? 'Saving...' : isSaved ? 'Saved!' : 'Save Configuration'}
                        </button>
                    </div>
                </div>
            )}

            {/* Role Mapping Tab */}
            {activeTab === 'mapping' && (
                <div className="space-y-6">
                    <div className="bg-slate-900/50 rounded-lg p-6 border border-slate-700/50">
                        <div className="flex flex-col sm:flex-row justify-between sm:items-center mb-4 flex-wrap gap-4">
                            <div>
                                <h2 className="text-xl text-white">Discord Role Mapping</h2>
                                <p className="text-sm text-slate-400 mt-1">Map Discord server roles to platform ranks and permission levels.</p>
                            </div>
                            <div className="flex items-center space-x-2">
                                <button onClick={handleFetchRoles} disabled={isFetching} className="flex items-center px-4 py-2 text-sm font-semibold text-white bg-slate-600 rounded-md hover:bg-slate-700 transition-colors disabled:bg-slate-800">
                                    <i className={`fa-solid fa-rotate h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
                                    {isFetching ? 'Fetching...' : 'Fetch Server Roles'}
                                </button>
                                <button onClick={() => setIsSyncUsersModalOpen(true)} className="flex items-center px-4 py-2 text-sm font-semibold text-white bg-slate-700 border border-slate-600 rounded-md hover:bg-slate-600 transition-colors disabled:bg-slate-800">
                                    <i className="fa-solid fa-users-gear h-4 w-4 mr-2" />
                                    Sync All Users
                                </button>
                            </div>
                        </div>

                        <div className="bg-amber-500/10 border border-amber-500/30 p-3 rounded-md mb-4 text-sm text-amber-300">
                            <i className="fa-solid fa-arrows-rotate mr-2"></i>
                            <strong>Bi-directional sync:</strong> When a member's rank or role is changed on the platform, their Discord roles will be updated automatically to match.
                        </div>

                        {syncedDiscordRoles.length > 0 ? (
                            <>
                                {/* Header row */}
                                <div className="hidden sm:grid sm:grid-cols-3 gap-3 px-3 py-2 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-700/50 mb-2">
                                    <div>Discord Role</div>
                                    <div>Platform Rank</div>
                                    <div>Permission Level</div>
                                </div>
                                <div className="space-y-2">
                                    {syncedDiscordRoles.map(role => (
                                        <div key={role.id} className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-center bg-slate-800/70 p-3 rounded-md">
                                            <div className="flex items-center space-x-3">
                                                <div className="h-4 w-4 rounded-full shrink-0" style={{ backgroundColor: role.color }}></div>
                                                <span className="font-medium text-white text-sm">{role.name}</span>
                                            </div>
                                            <div>
                                                <label className="sm:hidden text-xs text-slate-400 mb-1 block">Rank</label>
                                                <select
                                                    value={rankMappings[role.id] || ''}
                                                    onChange={(e) => handleRankChange(role.id, e.target.value)}
                                                    className="w-full bg-slate-700 border border-slate-600 rounded-md p-2 text-white text-sm"
                                                >
                                                    <option value="">- No Rank -</option>
                                                    {[...ranks].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name)).map(rank => (
                                                        <option key={rank.id} value={rank.id}>{rank.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div>
                                                <label className="sm:hidden text-xs text-slate-400 mb-1 block">Permission Level</label>
                                                <select
                                                    value={roleMappings[role.id] || ''}
                                                    onChange={(e) => handleRoleChange(role.id, e.target.value)}
                                                    className="w-full bg-slate-700 border border-slate-600 rounded-md p-2 text-white text-sm"
                                                >
                                                    <option value="">- No Role -</option>
                                                    {assignableRoles.sort((a, b) => a.id - b.id).map(r => (
                                                        <option key={r.id} value={r.id}>{r.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </>
                        ) : (
                            <p className="text-center text-slate-500 py-8">No roles fetched. Click "Fetch Server Roles" to begin.</p>
                        )}
                    </div>

                    <div className="bg-slate-800/30 rounded-lg p-4 border border-slate-700/30 text-sm text-slate-400 space-y-2">
                        <p><i className="fa-solid fa-shield-halved mr-2 text-slate-500"></i><strong className="text-slate-300">Security note:</strong> The Admin permission level cannot be assigned via Discord sync. Only Member, Dispatcher, and custom roles are available.</p>
                        <p><i className="fa-solid fa-info-circle mr-2 text-slate-500"></i>When syncing from Discord, the first matching role in the user's Discord role list determines their rank and permission level.</p>
                        <p><i className="fa-solid fa-robot mr-2 text-slate-500"></i><strong className="text-slate-300">Bot requirement:</strong> For bi-directional sync, your Discord bot needs the <code className="bg-slate-700 px-1.5 py-0.5 rounded-sm text-xs">MANAGE_ROLES</code> permission and must have a role positioned higher than the roles it manages.</p>
                    </div>
                </div>
            )}
        </div>
    );
};

export default DiscordSettingsTab;
