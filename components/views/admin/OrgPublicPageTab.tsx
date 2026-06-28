import React, { useState, useEffect, useCallback } from 'react';
import { useConfig } from '../../../contexts/ConfigContext';
import { PublicPageConfig, PublicPageExternalLink, TestimonialCandidate } from '../../../types';
import MinimalRichEditor from '../../shared/editor/MinimalRichEditor';
import { tryParseTiptapJson } from '../../../lib/tiptapValidate';
import { TabPageHeader, SectionPanel } from '../../shared/ui';
import { useNotification } from '../../../contexts/NotificationContext';

const inputCls = "w-full bg-slate-900/60 border border-slate-700 rounded-lg p-2.5 text-white text-sm focus:ring-1 focus:ring-slate-400/50 focus:border-slate-500 outline-hidden transition-all";
const inputMonoCls = inputCls + " font-mono";
const LINK_URL_RE = /^(https:\/\/|discord:\/\/)/i;

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }> = ({ checked, onChange, label, hint }) => (
    <label className="flex items-start gap-3 cursor-pointer select-none">
        <span className={`relative inline-block w-10 h-6 shrink-0 mt-0.5 rounded-full transition-colors ${checked ? 'bg-sky-500' : 'bg-slate-700'}`}>
            <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`} />
        </span>
        <span>
            <span className="block text-sm text-slate-200">{label}</span>
            {hint && <span className="block text-[11px] text-slate-500 mt-0.5">{hint}</span>}
        </span>
    </label>
);

function genLinkId() {
    return `lnk_${Math.random().toString(36).slice(2, 10)}`;
}

function truncate(s: string, max: number) {
    return s.length > max ? s.slice(0, max) + '…' : s;
}

const Stars: React.FC<{ n: number }> = ({ n }) => (
    <span className="text-amber-400 text-xs">
        {Array.from({ length: 5 }, (_, i) => (
            <i key={i} className={`fa-solid fa-star ${i < n ? '' : 'opacity-25'} mr-0.5`} />
        ))}
    </span>
);

const TestimonialPickerModal: React.FC<{
    currentIds: string[];
    onAdd: (id: string) => void;
    onClose: () => void;
}> = ({ currentIds, onAdd, onClose }) => {
    const { listTestimonialCandidates } = useConfig();
    const [items, setItems] = useState<TestimonialCandidate[]>([]);
    const [total, setTotal] = useState(0);
    const [search, setSearch] = useState('');
    const [offset, setOffset] = useState(0);
    // Mount-time fetch shows the spinner immediately by initializing loading=true, so the
    // mount effect performs only the async fetch (no synchronous setLoading in the effect).
    const [loading, setLoading] = useState(true);
    const limit = 20;

    const [loadError, setLoadError] = useState<string | null>(null);
    // Async page fetch. All state settles on the promise chain (data/error/loading), so the
    // mount effect that calls this has no synchronously-reachable setState to flag.
    const fetchPage = useCallback(async (nextOffset: number, searchTerm: string) => {
        await listTestimonialCandidates({ search: searchTerm, limit, offset: nextOffset })
            .then((res) => { setItems(res.items || []); setTotal(res.total || 0); })
            .catch((e: any) => { setItems([]); setTotal(0); setLoadError(e?.message || 'Failed to load testimonials.'); })
            .finally(() => { setLoading(false); });
    }, [listTestimonialCandidates]);
    // Wrapper for user-initiated loads (search/prev/next): show the spinner and clear any
    // prior error synchronously before fetching, matching the original load() semantics.
    const load = useCallback(async (nextOffset: number, searchTerm: string) => {
        setLoading(true);
        setLoadError(null);
        await fetchPage(nextOffset, searchTerm);
    }, [fetchPage]);

    // Initial fetch on mount. loading starts true, so only the async fetch runs here.
    useEffect(() => { fetchPage(0, ''); }, [fetchPage]);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        setOffset(0);
        load(0, search);
    };

    const current = new Set(currentIds);
    const remaining = 6 - currentIds.length;

    return (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-3xl w-full max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
                <div className="p-4 border-b border-slate-700 flex items-center justify-between">
                    <div>
                        <h3 className="text-sm font-black uppercase tracking-widest text-slate-100">Pick Testimonials</h3>
                        <p className="text-[11px] text-slate-500 mt-0.5">{remaining} of 6 slots remaining · Previews are what visitors will see — no client names.</p>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-white" aria-label="Close">
                        <i className="fa-solid fa-xmark text-lg" />
                    </button>
                </div>
                <form onSubmit={handleSearch} className="p-4 border-b border-slate-800 flex gap-2">
                    <input
                        type="text"
                        placeholder="Search feedback text…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className={inputCls}
                    />
                    <button type="submit" className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold uppercase tracking-widest rounded-lg">Search</button>
                </form>
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                    {loading && <p className="text-slate-400 text-sm text-center py-6">Loading…</p>}
                    {!loading && loadError && (
                        <p className="text-red-400 text-sm text-center py-6">{loadError}</p>
                    )}
                    {!loading && !loadError && items.length === 0 && (
                        <p className="text-slate-500 text-sm text-center py-6">No rated service requests with written feedback yet.</p>
                    )}
                    {items.map((t) => {
                        const isSelected = current.has(t.id);
                        const isFull = remaining <= 0;
                        const disabled = isSelected || isFull;
                        return (
                            <div key={t.id} className={`p-3 rounded-lg border ${isSelected ? 'border-sky-500/40 bg-sky-500/5' : 'border-slate-700 bg-slate-800/40'}`}>
                                <div className="flex items-start justify-between gap-3">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-1 text-xs text-slate-400">
                                            <Stars n={t.rating} />
                                            <span>·</span>
                                            <span className="truncate">{t.serviceType}</span>
                                            <span>·</span>
                                            <span>{t.ratedAt}</span>
                                        </div>
                                        <p className="text-sm text-slate-200 leading-relaxed wrap-break-word">{truncate(t.quote, 240)}</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => onAdd(t.id)}
                                        disabled={disabled}
                                        className={`px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest rounded border shrink-0 ${disabled
                                            ? 'border-slate-700 text-slate-500 cursor-not-allowed'
                                            : 'border-sky-500/40 text-sky-300 hover:bg-sky-500/10'}`}
                                    >
                                        {isSelected ? 'Added' : isFull ? 'Full' : 'Add'}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div className="p-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-500">
                    <span>{total} total candidates</span>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={offset === 0 || loading}
                            onClick={() => { const n = Math.max(0, offset - limit); setOffset(n); load(n, search); }}
                            className="px-3 py-1 border border-slate-700 rounded-sm disabled:opacity-40"
                        >Prev</button>
                        <button
                            type="button"
                            disabled={offset + limit >= total || loading}
                            onClick={() => { const n = offset + limit; setOffset(n); load(n, search); }}
                            className="px-3 py-1 border border-slate-700 rounded-sm disabled:opacity-40"
                        >Next</button>
                    </div>
                </div>
            </div>
        </div>
    );
};

const OrgPublicPageTab: React.FC = () => {
    const { publicPageConfig, updatePublicPageConfig, listTestimonialCandidates } = useConfig();
    const { addToast } = useNotification();

    const [config, setConfig] = useState<PublicPageConfig>(publicPageConfig);
    const [isSaving, setIsSaving] = useState(false);
    const [isSaved, setIsSaved] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);

    // Cache: map internal id → candidate preview, so the "Selected" list can
    // display previews without exposing ids publicly or re-fetching per row.
    const [previewById, setPreviewById] = useState<Record<string, TestimonialCandidate>>({});

    // Re-seed the local editable form when the canonical config from context changes (e.g.
    // after a save), using React's "adjust state during render" pattern with a prev-value
    // tracker. config is user-editable local state, so it cannot be derived during render
    // without discarding in-progress edits — but on a genuine source change we DO replace it,
    // exactly as the old [publicPageConfig] effect did. React re-renders before paint, so this
    // is behavior-equivalent to the effect-reset.
    const [prevPublicPageConfig, setPrevPublicPageConfig] = useState(publicPageConfig);
    if (publicPageConfig !== prevPublicPageConfig) {
        setPrevPublicPageConfig(publicPageConfig);
        setConfig(publicPageConfig);
    }

    // Hydrate previews for any currently-selected ids we don't have cached.
    useEffect(() => {
        const missing = (config.featuredTestimonialIds || []).filter((id) => !previewById[id]);
        if (missing.length === 0) return;
        let cancelled = false;
        (async () => {
            try {
                // Fetch candidates in a generous batch; server returns only rated+feedback rows.
                const res = await listTestimonialCandidates({ limit: 100 });
                if (cancelled) return;
                const map: Record<string, TestimonialCandidate> = {};
                for (const t of res.items) map[t.id] = t;
                setPreviewById((prev) => ({ ...map, ...prev }));
            } catch {
                // Non-fatal — previews will show a "unavailable" placeholder.
            }
        })();
        return () => { cancelled = true; };
    }, [config.featuredTestimonialIds, listTestimonialCandidates, previewById]);

    const update = <K extends keyof PublicPageConfig>(key: K, value: PublicPageConfig[K]) => setConfig((prev) => ({ ...prev, [key]: value }));

    const updateModule = (key: keyof PublicPageConfig['modules'], value: boolean) =>
        setConfig((prev) => ({ ...prev, modules: { ...prev.modules, [key]: value } }));

    const addLink = () => {
        if (config.links.length >= 10) return;
        setConfig((prev) => ({
            ...prev,
            links: [...prev.links, { id: genLinkId(), label: '', url: '' }],
        }));
    };
    const updateLink = (idx: number, patch: Partial<PublicPageExternalLink>) => {
        setConfig((prev) => ({
            ...prev,
            links: prev.links.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
        }));
    };
    const removeLink = (idx: number) => setConfig((prev) => ({ ...prev, links: prev.links.filter((_, i) => i !== idx) }));
    const moveLink = (idx: number, dir: -1 | 1) => {
        const target = idx + dir;
        if (target < 0 || target >= config.links.length) return;
        setConfig((prev) => {
            const next = [...prev.links];
            [next[idx], next[target]] = [next[target], next[idx]];
            return { ...prev, links: next };
        });
    };

    const addTestimonial = (id: string) => {
        if (config.featuredTestimonialIds.includes(id)) return;
        if (config.featuredTestimonialIds.length >= 6) return;
        setConfig((prev) => ({ ...prev, featuredTestimonialIds: [...prev.featuredTestimonialIds, id] }));
    };
    const removeTestimonial = (id: string) => {
        setConfig((prev) => ({ ...prev, featuredTestimonialIds: prev.featuredTestimonialIds.filter((x) => x !== id) }));
    };
    const moveTestimonial = (idx: number, dir: -1 | 1) => {
        const target = idx + dir;
        if (target < 0 || target >= config.featuredTestimonialIds.length) return;
        setConfig((prev) => {
            const next = [...prev.featuredTestimonialIds];
            [next[idx], next[target]] = [next[target], next[idx]];
            return { ...prev, featuredTestimonialIds: next };
        });
    };

    const validate = (): string | null => {
        if ((config.motto || '').length > 120) return 'Motto must be 120 characters or fewer.';
        if ((config.blurb || '').length > 4000) return 'Blurb must be 4000 characters or fewer.';
        if (config.heroImageUrl && !/^https:\/\//i.test(config.heroImageUrl)) return 'Hero image URL must start with https://';
        if (config.profileImageUrl && !/^https:\/\//i.test(config.profileImageUrl)) return 'Profile image URL must start with https://';
        if (config.links.length > 10) return 'At most 10 external links are allowed.';
        for (const l of config.links) {
            if (!l.label || !l.url) return 'Every link needs a label and a URL.';
            if (!LINK_URL_RE.test(l.url)) return `Link "${l.label}" must start with https:// or discord://`;
        }
        if (config.featuredTestimonialIds.length > 6) return 'At most 6 featured testimonials are allowed.';
        return null;
    };

    const handleSave = async () => {
        const err = validate();
        if (err) {
            addToast('Invalid Public Page Config', <i className="fa-solid fa-triangle-exclamation" />, 'bg-amber-500/10 text-amber-400 border-amber-500/50', { description: err });
            return;
        }
        setIsSaving(true);
        try {
            await updatePublicPageConfig(config);
            setIsSaved(true);
            setTimeout(() => setIsSaved(false), 2000);
        } catch (e: any) {
            addToast('Save Failed', <i className="fa-solid fa-xmark" />, 'bg-red-500/10 text-red-400 border-red-500/50', { description: e?.message || 'Failed to save public page config.' });
        } finally {
            setIsSaving(false);
        }
    };

    const mottoLen = (config.motto || '').length;
    const blurbLen = (config.blurb || '').length;

    return (
        <div className="p-4 md:p-8 space-y-6 animate-fade-in">
            <TabPageHeader
                title="Public Landing Page"
                icon="fa-solid fa-globe"
                accent="sky"
                subtitle="Replace the default Discord login screen with a branded landing page for visitors who aren't signed in."
            />


            <SectionPanel title="Visibility" icon="fa-solid fa-eye">
                <Toggle
                    checked={!!config.enabled}
                    onChange={(v) => update('enabled', v)}
                    label="Enable public landing page"
                    hint="When enabled, logged-out visitors see your landing page instead of the Discord login screen. Internal users can still reach the login screen at /login."
                />
            </SectionPanel>

            <SectionPanel title="Content" icon="fa-solid fa-pen">
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Motto <span className="text-[10px] text-slate-500 font-mono">({mottoLen}/120)</span></label>
                        <input
                            type="text"
                            maxLength={120}
                            value={config.motto || ''}
                            onChange={(e) => update('motto', e.target.value)}
                            placeholder="A short tagline for your org"
                            className={inputCls}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-300 mb-2">Blurb <span className="text-[10px] text-slate-500 font-mono">({blurbLen}/4000)</span></label>
                        {/* Tiptap editor (minimal toolbar). Stored as Tiptap JSON
                            serialized to a string; legacy plain-text blurbs are
                            upgraded automatically on first save. */}
                        <BlurbEditor value={config.blurb || ''} onChange={(v) => update('blurb', v)} />
                        <p className="text-[10px] text-slate-500 mt-1">Bold, italics, headings, lists, and links are supported. Other formatting is stripped on save.</p>
                    </div>
                </div>
            </SectionPanel>

            <SectionPanel title="Imagery" icon="fa-solid fa-image" note="Banner image behind the profile header and a circular avatar overlapping it. The avatar falls back to your Organization Identity logo when unset.">
                <div className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
                        <div className="md:col-span-3 space-y-2">
                            <label className="block text-sm font-medium text-slate-300">Hero Banner Image URL</label>
                            <input
                                type="url"
                                value={config.heroImageUrl || ''}
                                onChange={(e) => update('heroImageUrl', e.target.value)}
                                placeholder="https://example.com/banner.jpg"
                                className={inputMonoCls}
                            />
                            <p className="text-[10px] text-slate-500">Must start with https://. Recommended: a wide 2560×640 image. Leave blank for the default gradient.</p>
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-sm font-medium text-slate-300 mb-2 text-center">Banner Preview</label>
                            <div className="w-full aspect-4/1 bg-slate-950/60 rounded-xl border border-slate-700 flex items-center justify-center overflow-hidden shadow-inner">
                                {config.heroImageUrl ? (
                                    <img src={config.heroImageUrl} alt="Banner preview" className="w-full h-full object-cover" onError={(e) => { (e.currentTarget.style.display = 'none'); }} />
                                ) : (
                                    <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">No image set</span>
                                )}
                            </div>
                        </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-5 gap-6">
                        <div className="md:col-span-3 space-y-2">
                            <label className="block text-sm font-medium text-slate-300">Profile Image URL</label>
                            <input
                                type="url"
                                value={config.profileImageUrl || ''}
                                onChange={(e) => update('profileImageUrl', e.target.value)}
                                placeholder="https://example.com/avatar.png"
                                className={inputMonoCls}
                            />
                            <p className="text-[10px] text-slate-500">Must start with https://. Square image (512×512+). Leave blank to reuse your Organization Identity logo.</p>
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-sm font-medium text-slate-300 mb-2 text-center">Profile Preview</label>
                            <div className="w-full aspect-square max-w-[140px] mx-auto bg-slate-950/60 rounded-full border-4 border-slate-700 flex items-center justify-center overflow-hidden shadow-inner">
                                {config.profileImageUrl ? (
                                    <img src={config.profileImageUrl} alt="Profile preview" className="w-full h-full object-cover" onError={(e) => { (e.currentTarget.style.display = 'none'); }} />
                                ) : (
                                    <span className="text-[9px] text-slate-500 font-mono uppercase tracking-widest text-center p-2">Falls back to org logo</span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </SectionPanel>

            <SectionPanel title="Modules" icon="fa-solid fa-layer-group" note="Toggle the sections that appear on your landing page">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Toggle checked={config.modules.stats} onChange={(v) => updateModule('stats', v)} label="Service Request Stats" hint="Total completed, average rating, response time, last 30 days." />
                    <Toggle checked={config.modules.testimonials} onChange={(v) => updateModule('testimonials', v)} label="Client Testimonials" hint="Up to 6 hand-picked anonymous quotes." />
                    <Toggle checked={config.modules.services} onChange={(v) => updateModule('services', v)} label="Services Offered" hint="Grid of your active service types." />
                    <Toggle checked={config.modules.links} onChange={(v) => updateModule('links', v)} label="External Links" hint="Discord invite, RSI page, website, etc." />
                </div>
            </SectionPanel>

            {config.modules.testimonials && (
                <SectionPanel title="Featured Testimonials" icon="fa-solid fa-comment-dots" note="Select 3–6 quotes to show publicly. All testimonials are displayed anonymously — no client names are ever published.">
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <p className="text-xs text-slate-400 font-mono uppercase tracking-widest">{config.featuredTestimonialIds.length} / 6 featured</p>
                            <button
                                type="button"
                                disabled={config.featuredTestimonialIds.length >= 6}
                                onClick={() => setPickerOpen(true)}
                                className="px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-sm border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                <i className="fa-solid fa-plus mr-1.5" /> Add Testimonial
                            </button>
                        </div>
                        {config.featuredTestimonialIds.length === 0 && (
                            <p className="text-sm text-slate-500 italic">No testimonials selected yet.</p>
                        )}
                        {config.featuredTestimonialIds.map((id, idx) => {
                            const preview = previewById[id];
                            return (
                                <div key={id} className="p-3 rounded-lg border border-slate-700 bg-slate-800/40 flex items-start gap-3">
                                    <div className="flex flex-col gap-1 pt-1">
                                        <button type="button" onClick={() => moveTestimonial(idx, -1)} disabled={idx === 0} className="text-slate-400 hover:text-white disabled:opacity-30" aria-label="Move up"><i className="fa-solid fa-chevron-up text-xs" /></button>
                                        <button type="button" onClick={() => moveTestimonial(idx, 1)} disabled={idx === config.featuredTestimonialIds.length - 1} className="text-slate-400 hover:text-white disabled:opacity-30" aria-label="Move down"><i className="fa-solid fa-chevron-down text-xs" /></button>
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        {preview ? (
                                            <>
                                                <div className="flex items-center gap-2 mb-1 text-xs text-slate-400">
                                                    <Stars n={preview.rating} />
                                                    <span>·</span>
                                                    <span className="truncate">{preview.serviceType}</span>
                                                    <span>·</span>
                                                    <span>{preview.ratedAt}</span>
                                                </div>
                                                <p className="text-sm text-slate-200 leading-relaxed wrap-break-word">{truncate(preview.quote, 240)}</p>
                                            </>
                                        ) : (
                                            <p className="text-sm text-slate-500 italic">Preview unavailable. Testimonial may have been deleted — the public page will silently skip it.</p>
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => removeTestimonial(id)}
                                        className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest rounded-sm border border-red-500/40 text-red-300 hover:bg-red-500/10 shrink-0"
                                    >Remove</button>
                                </div>
                            );
                        })}
                    </div>
                </SectionPanel>
            )}

            {config.modules.links && (
                <SectionPanel title="External Links" icon="fa-solid fa-link" note="Up to 10 links. URLs must start with https:// or discord://">
                    <div className="space-y-3">
                        {config.links.length === 0 && <p className="text-sm text-slate-500 italic">No links added yet.</p>}
                        {config.links.map((link, idx) => (
                            <div key={link.id} className="p-3 rounded-lg border border-slate-700 bg-slate-800/40 flex items-start gap-3">
                                <div className="flex flex-col gap-1 pt-1">
                                    <button type="button" onClick={() => moveLink(idx, -1)} disabled={idx === 0} className="text-slate-400 hover:text-white disabled:opacity-30" aria-label="Move up"><i className="fa-solid fa-chevron-up text-xs" /></button>
                                    <button type="button" onClick={() => moveLink(idx, 1)} disabled={idx === config.links.length - 1} className="text-slate-400 hover:text-white disabled:opacity-30" aria-label="Move down"><i className="fa-solid fa-chevron-down text-xs" /></button>
                                </div>
                                <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-2">
                                    <input type="text" placeholder="Label" maxLength={40} value={link.label} onChange={(e) => updateLink(idx, { label: e.target.value })} className={inputCls} />
                                    <input type="text" placeholder="https://…" value={link.url} onChange={(e) => updateLink(idx, { url: e.target.value })} className={inputMonoCls} />
                                    <input type="text" placeholder="Optional icon (e.g. fa-brands fa-discord)" value={link.icon || ''} onChange={(e) => updateLink(idx, { icon: e.target.value })} className={inputMonoCls + ' md:col-span-2'} />
                                </div>
                                <button type="button" onClick={() => removeLink(idx)} className="px-3 py-1.5 text-[11px] font-bold uppercase tracking-widest rounded-sm border border-red-500/40 text-red-300 hover:bg-red-500/10 shrink-0">Remove</button>
                            </div>
                        ))}
                        {config.links.length < 10 && (
                            <button type="button" onClick={addLink} className="px-3 py-2 text-xs font-bold uppercase tracking-widest rounded-sm border border-sky-500/40 text-sky-300 hover:bg-sky-500/10">
                                <i className="fa-solid fa-plus mr-1.5" /> Add Link
                            </button>
                        )}
                    </div>
                </SectionPanel>
            )}

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
                    {isSaving ? <><i className="fa-solid fa-spinner animate-spin mr-2" />Saving</> : isSaved ? <><i className="fa-solid fa-check mr-2" />Saved</> : 'Save Public Page'}
                </button>
            </div>

            {pickerOpen && (
                <TestimonialPickerModal
                    currentIds={config.featuredTestimonialIds}
                    onAdd={(id) => {
                        addTestimonial(id);
                    }}
                    onClose={() => setPickerOpen(false)}
                />
            )}
        </div>
    );
};

export default OrgPublicPageTab;

// Public blurb editor wrapper. Bridges the stored string (Tiptap JSON or legacy
// plain text) and the editor's content-as-object API; legacy text upgrades to
// JSON transparently on first save.
const BlurbEditor: React.FC<{ value: string; onChange: (next: string) => void }> = ({ value, onChange }) => {
    // Seed the editor once at mount; the editor manages its own state thereafter.
    // Re-seeding from `value` on every change would reset the user's caret position
    // mid-edit, so this deliberately captures the initial `value` only.
    const [initialContent] = useState(() => {
        const parsed = tryParseTiptapJson(value);
        if (parsed) return parsed;
        // Legacy plain text → wrap each line in a paragraph node so the
        // editor displays it correctly. Empty string → undefined to let
        // the editor show its placeholder.
        if (!value) return undefined;
        const lines = String(value).split(/\r?\n/);
        return {
            type: 'doc',
            content: lines.map(line => ({
                type: 'paragraph',
                content: line ? [{ type: 'text', text: line }] : undefined,
            })),
        };
    });
    return (
        <MinimalRichEditor
            content={initialContent}
            editable
            placeholder="Describe your organization, services, mission…"
            onChange={(json) => onChange(JSON.stringify(json))}
        />
    );
};
