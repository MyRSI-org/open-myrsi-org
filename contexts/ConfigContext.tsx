// ConfigContext owns the Config slices and their CRUD methods.
//
// Mounts OUTSIDE DataProvider so DataContext can call useConfig() inside its
// body and re-expose the Config fields on its own context value, keeping the
// useData() surface unchanged.
//
// externalTools / locations / radioChannels aren't strictly "configs" but share
// the admin-managed reference-data lifecycle (server-validated, globally scoped,
// low write rate), so they're grouped here.
//
// Hydration: registers a slice setter per slice with DataCore, populated when
// applyStateData(data) runs after a 'main'/'discord'/'external_tools' subset fetch.
//
// CRUD methods refresh the relevant subset after their RPC. refreshMainState/
// refreshDiscord/refreshExternalTools are defined in DataContext and registered
// here via register* callbacks so CRUD can refresh without depending on useData()
// (would cycle). updateDiscordConfig and the external-tool methods refresh their
// own subsets ('discord', 'external_tools') rather than 'main'.

import React, { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDataCore } from './DataCoreContext';
import {
    BrandingConfig, DiscordConfig, HeroCardConfig, OpenGraphConfig, RadioConfig,
    AIConfig, WikiHomeConfig, HRConfig, PublicPageConfig, ServiceTypeConfig,
    ExternalTool, RadioChannel, TestimonialCandidate,
} from '../types';

// Re-exports so domain consumers can import config types from either
// '../contexts/ConfigContext' or '../types/config'.
export type {
    BrandingConfig, DiscordConfig, HeroCardConfig, OpenGraphConfig, RadioConfig,
    AIConfig, WikiHomeConfig, HRConfig, PublicPageConfig, ServiceTypeConfig,
    ExternalTool, RadioChannel, TestimonialCandidate,
} from '../types';

// Default branding icon — mirrors DataContext.defaultIconUrl. Kept duplicated
// (not imported) to avoid a Config → Data import cycle.
const defaultIconUrl = '/media/cross-swords.png';

export interface ConfigContextValue {
    brandingConfig: BrandingConfig;
    discordConfig: DiscordConfig;
    heroCardConfig: HeroCardConfig;
    openGraphConfig: OpenGraphConfig;
    radioConfig: RadioConfig;
    aiConfig: AIConfig;
    wikiHomeConfig: WikiHomeConfig;
    hrConfig: HRConfig;
    publicPageConfig: PublicPageConfig;
    serviceTypes: ServiceTypeConfig[];
    externalTools: ExternalTool[];
    locations: any[];
    radioChannels: RadioChannel[];

    setBrandingConfig: React.Dispatch<React.SetStateAction<BrandingConfig>>;
    setDiscordConfig: React.Dispatch<React.SetStateAction<DiscordConfig>>;
    setHeroCardConfig: React.Dispatch<React.SetStateAction<HeroCardConfig>>;
    setOpenGraphConfig: React.Dispatch<React.SetStateAction<OpenGraphConfig>>;
    setRadioConfig: React.Dispatch<React.SetStateAction<RadioConfig>>;
    setAiConfig: React.Dispatch<React.SetStateAction<AIConfig>>;
    setWikiHomeConfig: React.Dispatch<React.SetStateAction<WikiHomeConfig>>;
    setHrConfig: React.Dispatch<React.SetStateAction<HRConfig>>;
    setPublicPageConfig: React.Dispatch<React.SetStateAction<PublicPageConfig>>;
    setServiceTypes: React.Dispatch<React.SetStateAction<ServiceTypeConfig[]>>;
    setExternalTools: React.Dispatch<React.SetStateAction<ExternalTool[]>>;
    setLocations: React.Dispatch<React.SetStateAction<any[]>>;
    setRadioChannels: React.Dispatch<React.SetStateAction<RadioChannel[]>>;

    // Locations CRUD
    addLocation: (data: any) => Promise<void>;
    updateLocation: (data: any) => Promise<void>;
    deleteLocation: (id: number) => Promise<void>;
    seedDefaultLocations: () => Promise<any>;

    // Service Types CRUD
    addServiceType: (data: any) => Promise<void>;
    updateServiceType: (data: any) => Promise<void>;
    deleteServiceType: (id: number) => Promise<void>;

    // External Tools CRUD
    addExternalTool: (data: any) => Promise<void>;
    updateExternalTool: (data: any) => Promise<void>;
    deleteExternalTool: (id: number) => Promise<void>;
    reorderExternalTool: (id: number, sortOrder: number) => Promise<void>;

    // Radio Channels CRUD
    deleteRadioChannel: (channelId: string) => Promise<void>;

    // Config update methods
    updateDiscordConfig: (config: any) => Promise<void>;
    updateHeroCardConfig: (config: HeroCardConfig) => Promise<void>;
    updateBrandingConfig: (config: any) => Promise<void>;
    updateOpenGraphConfig: (config: OpenGraphConfig) => Promise<void>;
    updateRadioConfig: (config: any) => Promise<void>;
    updateAIConfig: (config: any) => Promise<void>;
    updateWikiHomeConfig: (config: WikiHomeConfig) => Promise<void>;
    updateSystemConfig: (appUrl: string) => Promise<void>;
    updatePublicPageConfig: (config: PublicPageConfig) => Promise<void>;
    updateOrgFeatures: (patch: Record<string, any>) => Promise<void>;

    listTestimonialCandidates: (params: { search?: string; limit?: number; offset?: number }) => Promise<{ items: TestimonialCandidate[]; total: number }>;

    /** DataContext registers its refreshMainState callback here once defined;
     *  Config's CRUD methods invoke it after their RPC completes. */
    registerRefreshMainState: (fn: () => Promise<void> | void) => () => void;
    /** Same, for the 'discord' subset — used by updateDiscordConfig, which
     *  pulls additional joined data not in the 'main' bundle. */
    registerRefreshDiscord: (fn: () => Promise<void> | void) => () => void;
    /** Same, for the 'external_tools' subset — used by the external-tool CRUD
     *  methods. External tools are their own subset because the realtime
     *  postgres_changes listener on the external_tools table dispatches to it. */
    registerRefreshExternalTools: (fn: () => Promise<void> | void) => () => void;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

export const ConfigProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { rpcAction, registerSliceSetter } = useDataCore();

    const [brandingConfig, setBrandingConfig] = useState<BrandingConfig>({ name: '', iconUrl: defaultIconUrl });
    const [discordConfig, setDiscordConfig] = useState<DiscordConfig>({});
    const [heroCardConfig, setHeroCardConfig] = useState<HeroCardConfig>({ backgroundImageUrl: '', discordUrl: '', organizationUrl: '', title: '', subtitle: '' });
    const [openGraphConfig, setOpenGraphConfig] = useState<OpenGraphConfig>({ title: '', description: '', imageUrl: '' });
    const [radioConfig, setRadioConfig] = useState<RadioConfig>({ channelName: '' });
    const [aiConfig, setAiConfig] = useState<AIConfig>({ enabled: false, model: 'gemini-2.5-flash' });
    const [wikiHomeConfig, setWikiHomeConfig] = useState<WikiHomeConfig>({});
    const [hrConfig, setHrConfig] = useState<HRConfig>({});
    const [publicPageConfig, setPublicPageConfig] = useState<PublicPageConfig>({
        enabled: false,
        motto: '',
        blurb: '',
        heroImageUrl: '',
        profileImageUrl: '',
        modules: { stats: false, testimonials: false, services: false, links: false },
        links: [],
        featuredTestimonialIds: [],
    });
    const [serviceTypes, setServiceTypes] = useState<ServiceTypeConfig[]>([]);
    const [externalTools, setExternalTools] = useState<ExternalTool[]>([]);
    const [locations, setLocations] = useState<any[]>([]);
    const [radioChannels, setRadioChannels] = useState<RadioChannel[]>([]);

    // DataContext registers refreshMainState/refreshDiscord/refreshExternalTools
    // here on mount; held in refs so CRUD methods can call them without
    // re-creating callbacks on every render.
    const refreshMainStateRef = useRef<(() => Promise<void> | void) | null>(null);
    const refreshDiscordRef = useRef<(() => Promise<void> | void) | null>(null);
    const refreshExternalToolsRef = useRef<(() => Promise<void> | void) | null>(null);

    const registerRefreshMainState = useCallback((fn: () => Promise<void> | void) => {
        refreshMainStateRef.current = fn;
        return () => {
            if (refreshMainStateRef.current === fn) refreshMainStateRef.current = null;
        };
    }, []);
    const registerRefreshDiscord = useCallback((fn: () => Promise<void> | void) => {
        refreshDiscordRef.current = fn;
        return () => {
            if (refreshDiscordRef.current === fn) refreshDiscordRef.current = null;
        };
    }, []);
    const registerRefreshExternalTools = useCallback((fn: () => Promise<void> | void) => {
        refreshExternalToolsRef.current = fn;
        return () => {
            if (refreshExternalToolsRef.current === fn) refreshExternalToolsRef.current = null;
        };
    }, []);

    const refreshMain = useCallback(async () => {
        const fn = refreshMainStateRef.current;
        if (fn) await fn();
    }, []);
    const refreshDiscord = useCallback(async () => {
        const fn = refreshDiscordRef.current;
        if (fn) await fn();
    }, []);
    const refreshExternalTools = useCallback(async () => {
        const fn = refreshExternalToolsRef.current;
        if (fn) await fn();
    }, []);
    // Each setter applies its slice when applyStateData(data) runs after a
    // 'main'/'discord'/'external_tools' subset fetch. Keys match the field names
    // returned by getInitialState / getStateSubset on the server.
    useEffect(() => {
        const cleanups = [
            registerSliceSetter('brandingConfig', (data: any) => { if (data.brandingConfig) setBrandingConfig(data.brandingConfig); }),
            registerSliceSetter('discordConfig', (data: any) => { if (data.discordConfig) setDiscordConfig(data.discordConfig); }),
            registerSliceSetter('heroCardConfig', (data: any) => { if (data.heroCardConfig) setHeroCardConfig(data.heroCardConfig); }),
            registerSliceSetter('openGraphConfig', (data: any) => { if (data.openGraphConfig) setOpenGraphConfig(data.openGraphConfig); }),
            registerSliceSetter('radioConfig', (data: any) => { if (data.radioConfig) setRadioConfig(data.radioConfig); }),
            registerSliceSetter('aiConfig', (data: any) => { if (data.aiConfig) setAiConfig(data.aiConfig); }),
            registerSliceSetter('wikiHomeConfig', (data: any) => { if (data.wikiHomeConfig) setWikiHomeConfig(data.wikiHomeConfig); }),
            registerSliceSetter('hrConfig', (data: any) => { if (data.hrConfig) setHrConfig(data.hrConfig); }),
            registerSliceSetter('publicPageConfig', (data: any) => { if (data.publicPageConfig) setPublicPageConfig(data.publicPageConfig); }),
            registerSliceSetter('serviceTypes', (data: any) => { if (data.serviceTypes) setServiceTypes(data.serviceTypes); }),
            registerSliceSetter('externalTools', (data: any) => { if (data.externalTools) setExternalTools(data.externalTools); }),
            registerSliceSetter('locations', (data: any) => { if (data.locations) setLocations(data.locations); }),
            registerSliceSetter('radioChannels', (data: any) => { if (data.radioChannels) setRadioChannels(data.radioChannels); }),
        ];
        return () => cleanups.forEach(unreg => unreg());
    }, [registerSliceSetter]);

    // Locations CRUD
    const addLocation = useCallback((data: any) =>
        rpcAction('admin:add_location', data).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateLocation = useCallback((data: any) =>
        rpcAction('admin:update_location', data).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const deleteLocation = useCallback((id: number) =>
        rpcAction('admin:delete_location', { locationId: id }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const seedDefaultLocations = useCallback(() =>
        rpcAction('admin:seed_default_locations', {}).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    // Service Types CRUD
    const addServiceType = useCallback((data: any) =>
        rpcAction('admin:add_service_type', data).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateServiceType = useCallback((data: any) =>
        rpcAction('admin:update_service_type', data).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const deleteServiceType = useCallback((id: number) =>
        rpcAction('admin:delete_service_type', { id }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    // External Tools CRUD — refresh the 'external_tools' subset, not 'main'.
    const addExternalTool = useCallback((toolData: any) =>
        rpcAction('admin:add_tool', { toolData }).then(() => refreshExternalTools()),
    [rpcAction, refreshExternalTools]);

    const updateExternalTool = useCallback((toolData: any) =>
        rpcAction('admin:update_tool', { toolData }).then(() => refreshExternalTools()),
    [rpcAction, refreshExternalTools]);

    const deleteExternalTool = useCallback((id: number) =>
        rpcAction('admin:delete_tool', { toolId: id }).then(() => refreshExternalTools()),
    [rpcAction, refreshExternalTools]);

    const reorderExternalTool = useCallback((id: number, sortOrder: number) =>
        rpcAction('admin:reorder_tool', { toolId: id, sortOrder }).then(() => refreshExternalTools()),
    [rpcAction, refreshExternalTools]);

    // Radio Channels CRUD
    const deleteRadioChannel = useCallback((channelId: string) =>
        rpcAction('admin:delete_radio_channel', { channelId }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    // Config update methods
    const updateDiscordConfig = useCallback((config: any) =>
        rpcAction('admin:update_discord_config', config).then(() => refreshDiscord()),
    [rpcAction, refreshDiscord]);

    const updateHeroCardConfig = useCallback((config: HeroCardConfig) =>
        rpcAction('admin:update_hero_config', config).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateBrandingConfig = useCallback((config: any) =>
        rpcAction('admin:update_branding_config', config).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateOpenGraphConfig = useCallback((config: OpenGraphConfig) =>
        rpcAction('admin:update_opengraph_config', config).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateRadioConfig = useCallback((config: any) =>
        rpcAction('admin:update_radio_config', config).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateAIConfig = useCallback((config: any) =>
        rpcAction('admin:update_ai_config', config).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateWikiHomeConfig = useCallback((config: WikiHomeConfig) =>
        rpcAction('admin:update_wiki_home_config', config).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updateSystemConfig = useCallback((appUrl: string) =>
        rpcAction('admin:update_system_config', { appUrl }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const updatePublicPageConfig = useCallback((config: PublicPageConfig) =>
        rpcAction('admin:update_public_page_config', config).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    /**
     * Toggle / merge-update the org's optional-module flags (government, finances,
     * quartermaster, warehouse, ...). Patch is deep-merged server-side so sibling
     * flags under the same feature are preserved.
     * Example: updateOrgFeatures({ quartermaster: { enabled: true } }) leaves any
     *          sibling quartermaster flags untouched.
     */
    const updateOrgFeatures = useCallback((patch: Record<string, any>) =>
        rpcAction('admin:update_features', { patch }).then(() => refreshMain()),
    [rpcAction, refreshMain]);

    const listTestimonialCandidates = useCallback(
        (params: { search?: string; limit?: number; offset?: number }) =>
            rpcAction('admin:list_testimonial_candidates', params) as Promise<{ items: TestimonialCandidate[]; total: number }>,
        [rpcAction],
    );

    const value = useMemo<ConfigContextValue>(() => ({
        brandingConfig, discordConfig, heroCardConfig, openGraphConfig, radioConfig,
        aiConfig, wikiHomeConfig, hrConfig, publicPageConfig,
        serviceTypes, externalTools, locations, radioChannels,
        setBrandingConfig, setDiscordConfig, setHeroCardConfig, setOpenGraphConfig, setRadioConfig,
        setAiConfig, setWikiHomeConfig, setHrConfig, setPublicPageConfig,
        setServiceTypes, setExternalTools, setLocations, setRadioChannels,
        addLocation, updateLocation, deleteLocation, seedDefaultLocations,
        addServiceType, updateServiceType, deleteServiceType,
        addExternalTool, updateExternalTool, deleteExternalTool, reorderExternalTool,
        deleteRadioChannel,
        updateDiscordConfig, updateHeroCardConfig, updateBrandingConfig, updateOpenGraphConfig,
        updateRadioConfig, updateAIConfig, updateWikiHomeConfig, updateSystemConfig,
        updatePublicPageConfig, updateOrgFeatures,
        listTestimonialCandidates,
        registerRefreshMainState, registerRefreshDiscord, registerRefreshExternalTools,
    }), [
        brandingConfig, discordConfig, heroCardConfig, openGraphConfig, radioConfig,
        aiConfig, wikiHomeConfig, hrConfig, publicPageConfig,
        serviceTypes, externalTools, locations, radioChannels,
        addLocation, updateLocation, deleteLocation, seedDefaultLocations,
        addServiceType, updateServiceType, deleteServiceType,
        addExternalTool, updateExternalTool, deleteExternalTool, reorderExternalTool,
        deleteRadioChannel,
        updateDiscordConfig, updateHeroCardConfig, updateBrandingConfig, updateOpenGraphConfig,
        updateRadioConfig, updateAIConfig, updateWikiHomeConfig, updateSystemConfig,
        updatePublicPageConfig, updateOrgFeatures,
        listTestimonialCandidates,
        registerRefreshMainState, registerRefreshDiscord, registerRefreshExternalTools,
    ]);

    return <ConfigContext value={value}>{children}</ConfigContext>;
};

export const useConfig = (): ConfigContextValue => {
    const ctx = use(ConfigContext);
    if (!ctx) throw new Error('useConfig must be used within a ConfigProvider');
    return ctx;
};
