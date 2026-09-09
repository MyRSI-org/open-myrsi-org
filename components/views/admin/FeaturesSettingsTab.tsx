
import React, { useState } from 'react';
import { useData } from '../../../contexts/DataContext';
import { useConfig } from '../../../contexts/ConfigContext';
import { useGovernment } from '../../../contexts/GovernmentContext';
import { TabPageHeader } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';

/**
 * Toggle row for a single feature flag with optional description + sub-flags.
 */
interface ToggleProps {
    enabled: boolean;
    onToggle: () => void;
    disabled?: boolean;
    activeColor?: string;
}

const Toggle: React.FC<ToggleProps> = ({ enabled, onToggle, disabled = false, activeColor = 'bg-emerald-600' }) => (
    <button
        type="button"
        onClick={onToggle}
        disabled={disabled}
        className={`w-12 h-6 rounded-full p-1 transition-colors duration-200 ease-in-out shrink-0 ${enabled ? activeColor : 'bg-slate-600'} ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
        <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform duration-200 ease-in-out ${enabled ? 'translate-x-6' : 'translate-x-0'}`}></div>
    </button>
);

const FeaturesSettingsTab: React.FC = () => {
    const { orgMeta, rpcAction } = useData();
    const { updateOrgFeatures } = useConfig();
    const { governmentsFeatureConfig, refreshGovernment } = useGovernment();
    const { addToast, confirm } = useNotification();
    const [savingKey, setSavingKey] = useState<string | null>(null);

    const features = orgMeta?.features || {};
    const finances = (features.finances || {}) as { enabled?: boolean };
    const quartermaster = (features.quartermaster || {}) as { enabled?: boolean };
    const warehouse = (features.warehouse || {}) as { enabled?: boolean };
    const marketplace = (features.marketplace || {}) as { enabled?: boolean };
    const academy = (features.academy || {}) as { enabled?: boolean };
    const blueprints = (features.blueprints || {}) as { enabled?: boolean };
    // Leaderboard and External Tools default ON — absent/undefined means enabled.
    const leaderboard = (features.leaderboard || {}) as { enabled?: boolean };
    const externalTools = (features.externalTools || {}) as { enabled?: boolean };
    const leaderboardEnabled = leaderboard.enabled !== false;
    const externalToolsEnabled = externalTools.enabled !== false;

    // Government uses a separate config table (settings.governmentsConfig), not the
    // organizations.features JSONB — so it has its own RPC path.
    const governmentEnabled = !!governmentsFeatureConfig?.enabled;

    const toggleGovernment = async () => {
        const next = !governmentEnabled;
        if (!next) {
            const ok = await confirm({
                title: 'Disable Government?',
                message: 'Government structure, positions, elections, and legislation are preserved but hidden from all members until re-enabled.',
                confirmText: 'Disable',
                variant: 'warning',
            });
            if (!ok) return;
        }
        setSavingKey('government.enabled');
        try {
            await rpcAction('gov:update_feature_config', { config: { enabled: next } });
            await refreshGovernment();
            addToast(
                'Feature Updated',
                <i className="fa-solid fa-check"></i>,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50',
            );
        } catch (err: any) {
            addToast(
                'Update Failed',
                <i className="fa-solid fa-xmark"></i>,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Failed to update government feature.' },
            );
        } finally {
            setSavingKey(null);
        }
    };

    const applyPatch = async (key: string, patch: Record<string, any>, confirmMsg?: string) => {
        if (confirmMsg) {
            const ok = await confirm({ title: 'Confirm change', message: confirmMsg });
            if (!ok) return;
        }
        setSavingKey(key);
        try {
            await updateOrgFeatures(patch);
            addToast(
                'Feature Updated',
                <i className="fa-solid fa-check"></i>,
                'bg-emerald-500/10 text-emerald-400 border-emerald-500/50',
            );
        } catch (err: any) {
            console.error(err);
            addToast(
                'Update Failed',
                <i className="fa-solid fa-xmark"></i>,
                'bg-red-500/10 text-red-400 border-red-500/50',
                { description: err?.message || 'Failed to update feature.' },
            );
        } finally {
            setSavingKey(null);
        }
    };

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Optional Features"
                icon="fa-solid fa-toggle-on"
                accent="emerald"
                subtitle="Turn on or off optional modules for your organization. Disabled modules are hidden from all members and their backend actions are rejected."
            />

            <div className="bg-slate-900/50 rounded-lg p-6 border border-slate-700/50">
                <div className="space-y-4 max-w-3xl">
                    {/* GOVERNMENT */}
                    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
                        <div className="flex items-start gap-4 p-5">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                                <i className="fa-solid fa-landmark text-indigo-400"></i>
                            </div>
                            <div className="flex-1">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="font-semibold text-white">Government</h3>
                                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                            Let your organization establish branches, positions, elections, and legislation. Full configuration &mdash; templates, constitution, seats &mdash; is managed from the <span className="text-indigo-300 font-semibold">Government</span> tab when enabled.
                                        </p>
                                    </div>
                                    <Toggle
                                        enabled={governmentEnabled}
                                        disabled={savingKey === 'government.enabled'}
                                        onToggle={toggleGovernment}
                                        activeColor="bg-indigo-500"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* FINANCES */}
                    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
                        <div className="flex items-start gap-4 p-5">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-amber-500/10 flex items-center justify-center">
                                <i className="fa-solid fa-vault text-amber-300"></i>
                            </div>
                            <div className="flex-1">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="font-semibold text-white">Finances</h3>
                                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                            Track your org's in-game bank alt-account as a proper ledger. Members submit deposits with an in-game transfer memo; officers confirm against the real alt. Withdrawals, adjustments, and reversals are all audited. No real money — aUEC only.
                                        </p>
                                    </div>
                                    <Toggle
                                        enabled={!!finances.enabled}
                                        disabled={savingKey === 'finances.enabled'}
                                        onToggle={() => {
                                            const next = !finances.enabled;
                                            applyPatch(
                                                'finances.enabled',
                                                { finances: { enabled: next } },
                                                next
                                                    ? undefined
                                                    : 'Disabling Finances will hide accounts and the ledger from all members. All records are preserved and will return when re-enabled.',
                                            );
                                        }}
                                        activeColor="bg-amber-500"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* QUARTERMASTER */}
                    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
                        <div className="flex items-start gap-4 p-5">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-orange-500/10 flex items-center justify-center">
                                <i className="fa-solid fa-warehouse text-orange-400"></i>
                            </div>
                            <div className="flex-1">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="font-semibold text-white">Quartermaster</h3>
                                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                            Track your org's physical in-game assets — armour, weapons, components, consumables — across locations. Log current stock, issue kit to members for operations, track returns with outcomes (returned on time, damaged, lost, destroyed in action). Append-only movement ledger with full audit.
                                        </p>
                                    </div>
                                    <Toggle
                                        enabled={!!quartermaster.enabled}
                                        disabled={savingKey === 'quartermaster.enabled'}
                                        onToggle={() => {
                                            const next = !quartermaster.enabled;
                                            applyPatch(
                                                'quartermaster.enabled',
                                                { quartermaster: { enabled: next } },
                                                next
                                                    ? undefined
                                                    : 'Disabling Quartermaster will hide the armoury and all issuance data from members. All records are preserved and will return when re-enabled.',
                                            );
                                        }}
                                        activeColor="bg-orange-500"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* WAREHOUSE */}
                    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
                        <div className="flex items-start gap-4 p-5">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-cyan-500/10 flex items-center justify-center">
                                <i className="fa-solid fa-boxes-stacked text-cyan-400"></i>
                            </div>
                            <div className="flex-1">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="font-semibold text-white">Warehouse</h3>
                                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                            Track bulk fungible commodities — ore, refined materials, fuel, RMC, missiles — across your warehouses. Sister module to Quartermaster, but for stock that gets <em>consumed, sold, or transported</em> rather than issued and returned. Quality bands per commodity, withdrawal request flow, transfer between locations, append-only movement ledger.
                                        </p>
                                    </div>
                                    <Toggle
                                        enabled={!!warehouse.enabled}
                                        disabled={savingKey === 'warehouse.enabled'}
                                        onToggle={() => {
                                            const next = !warehouse.enabled;
                                            applyPatch(
                                                'warehouse.enabled',
                                                { warehouse: { enabled: next } },
                                                next
                                                    ? undefined
                                                    : 'Disabling Warehouse will hide the warehouse view and all withdrawal data from members. All records are preserved and will return when re-enabled.',
                                            );
                                        }}
                                        activeColor="bg-cyan-500"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* LEADERBOARD */}
                    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
                        <div className="flex items-start gap-4 p-5">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                                <i className="fa-solid fa-trophy text-yellow-300"></i>
                            </div>
                            <div className="flex-1">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="font-semibold text-white">Leaderboard</h3>
                                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                            A ranked view of member performance — missions completed, aUEC earned, average rating, largest payouts. Healthy competition for orgs that run contract work; noise for orgs that don't. On by default.
                                        </p>
                                    </div>
                                    <Toggle
                                        enabled={leaderboardEnabled}
                                        disabled={savingKey === 'leaderboard.enabled'}
                                        onToggle={() => {
                                            const next = !leaderboardEnabled;
                                            applyPatch(
                                                'leaderboard.enabled',
                                                { leaderboard: { enabled: next } },
                                                next
                                                    ? undefined
                                                    : 'Disabling the Leaderboard will remove it from the sidebar for all members. Stats continue to accrue and will return when re-enabled.',
                                            );
                                        }}
                                        activeColor="bg-yellow-500"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* EXTERNAL TOOLS */}
                    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
                        <div className="flex items-start gap-4 p-5">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-sky-500/10 flex items-center justify-center">
                                <i className="fa-solid fa-toolbox text-sky-300"></i>
                            </div>
                            <div className="flex-1">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="font-semibold text-white">External Tools</h3>
                                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                            A curated launcher for third-party links your members use — uexcorp, verse mapping, DPS calculators. Hide the module entirely if your org doesn't curate external resources. On by default.
                                        </p>
                                    </div>
                                    <Toggle
                                        enabled={externalToolsEnabled}
                                        disabled={savingKey === 'externalTools.enabled'}
                                        onToggle={() => {
                                            const next = !externalToolsEnabled;
                                            applyPatch(
                                                'externalTools.enabled',
                                                { externalTools: { enabled: next } },
                                                next
                                                    ? undefined
                                                    : 'Disabling External Tools will hide the launcher from all members. Curated tools are preserved and will return when re-enabled.',
                                            );
                                        }}
                                        activeColor="bg-sky-500"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* MARKETPLACE */}
                    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
                        <div className="flex items-start gap-4 p-5">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                                <i className="fa-solid fa-store text-indigo-400"></i>
                            </div>
                            <div className="flex-1">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="font-semibold text-white">Marketplace</h3>
                                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                            An internal trading board where members post listings — items to sell or buy, services to offer or request — and run them through a negotiate → accept → deliver → confirm contract lifecycle with mutual ratings. Item listings can optionally reserve and move real warehouse stock. Prices are in aUEC for negotiation; settlement happens in-game. Off by default.
                                        </p>
                                    </div>
                                    <Toggle
                                        enabled={!!marketplace.enabled}
                                        disabled={savingKey === 'marketplace.enabled'}
                                        onToggle={() => {
                                            const next = !marketplace.enabled;
                                            applyPatch(
                                                'marketplace.enabled',
                                                { marketplace: { enabled: next } },
                                                next
                                                    ? undefined
                                                    : 'Disabling the Marketplace hides the trading board from all members. Listings, contracts, and ratings are preserved and will return when re-enabled.',
                                            );
                                        }}
                                        activeColor="bg-indigo-500"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* ACADEMY */}
                    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
                        <div className="flex items-start gap-4 p-5">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-purple-500/10 flex items-center justify-center">
                                <i className="fa-solid fa-graduation-cap text-purple-400"></i>
                            </div>
                            <div className="flex-1">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="font-semibold text-white">Academy</h3>
                                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                            A learning-management system for your org. Admins and instructors build courses of modules, lessons, and outcomes that run as scheduled <span className="text-purple-300 font-semibold">sessions</span>, or self-paced from the catalogue. Members enrol, learn at their own pace, and instructors mark each outcome competent or not yet competent. Finishing a course can award an org <span className="text-purple-300 font-semibold">certification</span>. Off by default.
                                        </p>
                                    </div>
                                    <Toggle
                                        enabled={!!academy.enabled}
                                        disabled={savingKey === 'academy.enabled'}
                                        onToggle={() => {
                                            const next = !academy.enabled;
                                            applyPatch(
                                                'academy.enabled',
                                                { academy: { enabled: next } },
                                                next
                                                    ? undefined
                                                    : 'Disabling the Academy hides it from all members and closes its actions server-side. Courses, sessions, enrolments, and progress are preserved and will return when re-enabled.',
                                            );
                                        }}
                                        activeColor="bg-purple-500"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* BLUEPRINTS */}
                    <div className="bg-slate-800/50 rounded-lg border border-slate-700 overflow-hidden">
                        <div className="flex items-start gap-4 p-5">
                            <div className="w-10 h-10 shrink-0 rounded-lg bg-purple-500/10 flex items-center justify-center">
                                <i className="fa-solid fa-scroll text-purple-400"></i>
                            </div>
                            <div className="flex-1">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h3 className="font-semibold text-white">Blueprint Manager</h3>
                                        <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                            A registry of what your members can make, and a two-sided <span className="text-purple-300 font-semibold">crafting board</span> on top of it. A member registers a blueprint and opts in to craft it for others; anyone can then raise a request, a crafter claims it, marks it ready and delivered, and the <span className="text-purple-300 font-semibold">requester</span> confirms receipt. Offering to craft is always the owner's own choice — nobody, moderator included, can switch it on for them. Off by default.
                                        </p>
                                    </div>
                                    <Toggle
                                        enabled={!!blueprints.enabled}
                                        disabled={savingKey === 'blueprints.enabled'}
                                        onToggle={() => {
                                            const next = !blueprints.enabled;
                                            applyPatch(
                                                'blueprints.enabled',
                                                { blueprints: { enabled: next } },
                                                next
                                                    ? undefined
                                                    : 'Disabling Blueprints hides it from all members and closes its actions server-side. The registry and every crafting request are preserved and will return when re-enabled.',
                                            );
                                        }}
                                        activeColor="bg-purple-500"
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="mt-6 p-3 bg-black/40 rounded-sm border border-slate-800 text-[10px] text-slate-500 leading-relaxed uppercase tracking-widest">
                    <i className="fa-solid fa-circle-info mr-2 text-slate-400"></i>
                    Feature toggles save instantly. Changes propagate to all logged-in members via realtime.
                </div>
            </div>
        </div>
    );
};

export default FeaturesSettingsTab;
