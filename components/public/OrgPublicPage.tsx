import React, { useEffect, useMemo, useState } from 'react';
import parse from 'html-react-parser';
import { Announcement } from '../../types';
import Notice from '../ui/Notice';

// OrgPublicPage is rendered BEFORE the user is authenticated and BEFORE
// DataContext is populated. It must not use useAuth/useData. All data comes
// from window.__PUBLIC_PAGE__ (SSR-injected) and /api/public (unauth endpoints).

interface PublicPagePayload {
    enabled: boolean;
    org: { name: string; iconUrl: string };
    motto: string;
    blurb: string;
    // Server-emitted sanitized HTML rendering of the rich blurb. Empty
    // string when the stored blurb is plain text — fall back to `blurb`.
    blurbHtml?: string;
    heroImageUrl?: string;
    profileImageUrl?: string;
    modules: { stats: boolean; testimonials: boolean; services: boolean; links: boolean };
    links: Array<{ id: string; label: string; url: string; icon?: string }>;
    /** 'Login Screen'-audience announcements, filtered + sorted newest-first server-side. */
    announcements?: Announcement[];
}

interface Stats {
    totalCompleted: number;
    avgRatingTimes10: number;
    avgResponseMinutes: number;
    last30Completed: number;
}

interface Testimonial {
    id: string;
    rating: number;
    quote: string;
    serviceType: string;
    ratedAt: string;
}

interface ServiceItem {
    name: string;
    icon: string;
    color: string;
    description: string;
}

function getPayload(): PublicPagePayload | null {
    if (typeof window === 'undefined') return null;
    const w = window as any;
    return w.__PUBLIC_PAGE__ || null;
}

function getSlug(): string {
    if (typeof window === 'undefined') return '';
    const host = window.location.hostname;
    const parts = host.split('.');
    return parts[0] || '';
}

async function fetchJson<T>(url: string): Promise<T | null> {
    try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    }
}

// --- Small reusable pieces ---

const Stars: React.FC<{ n: number }> = ({ n }) => (
    <span className="text-amber-400" aria-label={`${n} out of 5 stars`}>
        {Array.from({ length: 5 }, (_, i) => (
            <i key={i} className={`fa-solid fa-star ${i < n ? '' : 'opacity-25'} mr-0.5 text-xs`} aria-hidden />
        ))}
    </span>
);

const CardPanel: React.FC<{ children: React.ReactNode; className?: string; id?: string; 'aria-labelledby'?: string; as?: 'section' | 'aside' | 'div' }> = ({
    children, className = '', id, as = 'section', ...rest
}) => {
    const Tag: any = as;
    return (
        <Tag id={id} {...rest} className={`bg-slate-900/60 backdrop-blur-xs border border-slate-700/50 rounded-2xl shadow-lg ${className}`}>
            {children}
        </Tag>
    );
};

const CardHeader: React.FC<{ icon?: string; title: string; children?: React.ReactNode; id?: string }> = ({ icon, title, children, id }) => (
    <div className="px-6 pt-5 pb-3 border-b border-white/5 flex items-center justify-between gap-3">
        <h2 id={id} className="text-[11px] font-black uppercase tracking-[0.25em] text-slate-300 flex items-center gap-2">
            {icon && <i className={icon} aria-hidden />}
            {title}
        </h2>
        {children}
    </div>
);

// --- Profile header card (social-media style) ---

const ProfileHeaderCard: React.FC<{ payload: PublicPagePayload }> = ({ payload }) => {
    const avatar = payload.profileImageUrl || payload.org.iconUrl;
    return (
        <CardPanel as="section" aria-labelledby="profile-heading" className="overflow-hidden">
            {/* Banner */}
            <div className="relative w-full h-40 sm:h-56 bg-linear-to-br from-sky-900/40 via-slate-900 to-slate-950">
                {payload.heroImageUrl && (
                    <img
                        src={payload.heroImageUrl}
                        alt=""
                        className="absolute inset-0 w-full h-full object-cover"
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                    />
                )}
                <div className="absolute inset-0 bg-linear-to-b from-transparent via-transparent to-slate-900/80" aria-hidden />
            </div>
            {/* Avatar + name row */}
            <div className="relative px-6 pb-6">
                <div className="flex items-end gap-5 -mt-12 sm:-mt-14">
                    {avatar && (
                        <div className="relative shrink-0">
                            <div className="absolute inset-0 bg-sky-500 blur-2xl opacity-20 rounded-full" aria-hidden />
                            <img
                                src={avatar}
                                alt={payload.org.name}
                                className="relative w-24 h-24 sm:w-28 sm:h-28 rounded-2xl border-4 border-slate-900 bg-slate-900 object-cover shadow-[0_0_30px_rgba(14,165,233,0.25)]"
                                onError={(e) => { e.currentTarget.style.display = 'none'; }}
                            />
                        </div>
                    )}
                    <div className="flex-1 min-w-0 pb-1">
                        <h1 id="profile-heading" className="text-2xl sm:text-3xl font-black text-white tracking-tight leading-tight truncate">
                            {payload.org.name}
                        </h1>
                        {payload.motto && (
                            <p className="text-sky-300/80 text-xs sm:text-sm font-mono uppercase tracking-[0.2em] mt-1 truncate">
                                {payload.motto}
                            </p>
                        )}
                    </div>
                </div>
            </div>
        </CardPanel>
    );
};

// --- Notices card (login-screen audience, surfaced on the public page) ---

const NoticesCard: React.FC<{ announcements: Announcement[] }> = ({ announcements }) => (
    <CardPanel as="section" aria-labelledby="notices-heading">
        <CardHeader icon="fa-solid fa-bullhorn" title="Notices" id="notices-heading">
            <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">
                {announcements.length} active
            </span>
        </CardHeader>
        <div className="px-6 py-5 space-y-3">
            {announcements.map(a => (
                <Notice key={a.id} announcement={a} />
            ))}
        </div>
    </CardPanel>
);

// --- Blurb card ---

// Renders blurb. Prefers server-emitted sanitized HTML when present (rich-text
// editor save); falls back to plain text for legacy blurbs.
//
// blurbHtml is generated server-side by the JSON-to-safe-HTML walker in
// lib/tiptapValidate.ts, which only emits an allowlisted set of tags and
// HTML-escapes every text node — so dangerouslySetInnerHTML here is XSS-safe by
// construction. Do NOT swap to a different source without re-evaluating.
const BlurbCard: React.FC<{ text: string; html?: string }> = ({ text, html }) => (
    <CardPanel as="section" aria-labelledby="about-heading">
        <CardHeader icon="fa-solid fa-circle-info" title="About" id="about-heading" />
        <div className="px-6 py-5">
            {html ? (
                // Project doesn't ship @tailwindcss/typography, so `prose*`
                // classes are no-ops. The `.minimal-rich-editor-content`
                // rules in index.css are what give headings/lists/links
                // their visible structure — match the editor's own wrapper.
                <div className="minimal-rich-editor-content max-w-none text-sm sm:text-base">
                    {/* html is server-emitted blurbHtml, sanitized via tiptapJsonToSafeHtml
                        (lib/tiptapValidate.ts): tag allowlist + javascript:-URL stripping +
                        escapeHtml on every text node. Rendered to React elements via
                        html-react-parser — no raw HTML injection. */}
                    {parse(html)}
                </div>
            ) : (
                <p className="text-slate-300 text-sm sm:text-base leading-relaxed whitespace-pre-line">
                    {text}
                </p>
            )}
        </div>
    </CardPanel>
);

// --- Testimonials card (carousel lives inside) ---

const TestimonialsCard: React.FC<{ slug: string }> = ({ slug }) => {
    const [items, setItems] = useState<Testimonial[] | null>(null);
    const [index, setIndex] = useState(0);
    const [paused, setPaused] = useState(false);

    useEffect(() => {
        let cancelled = false;
        fetchJson<{ items: Testimonial[] }>(`/api/public?resource=testimonials&slug=${encodeURIComponent(slug)}`).then((data) => {
            if (!cancelled) setItems(data?.items || []);
        });
        return () => { cancelled = true; };
    }, [slug]);

    useEffect(() => {
        if (!items || items.length <= 1 || paused) return;
        const id = setInterval(() => setIndex((i) => (i + 1) % items.length), 7000);
        return () => clearInterval(id);
    }, [items, paused]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!items || items.length === 0) return;
        if (e.key === 'ArrowLeft') { setIndex((i) => (i - 1 + items.length) % items.length); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { setIndex((i) => (i + 1) % items.length); e.preventDefault(); }
        else if (e.key === 'Home') { setIndex(0); e.preventDefault(); }
        else if (e.key === 'End') { setIndex(items.length - 1); e.preventDefault(); }
    };

    if (!items || items.length === 0) return null;
    const current = items[index];

    return (
        <CardPanel as="section" aria-labelledby="testimonials-heading">
            <CardHeader icon="fa-solid fa-comment-dots" title="What Clients Say" id="testimonials-heading">
                {items.length > 1 && (
                    <div className="flex items-center gap-1.5">
                        {items.map((t, i) => (
                            <button
                                key={t.id}
                                type="button"
                                onClick={() => setIndex(i)}
                                aria-label={`Show testimonial ${i + 1}`}
                                aria-current={i === index}
                                className={`w-2 h-2 rounded-full transition-colors ${i === index ? 'bg-sky-400' : 'bg-slate-600 hover:bg-slate-500'}`}
                            />
                        ))}
                    </div>
                )}
            </CardHeader>
            <div
                role="region"
                aria-roledescription="carousel"
                aria-label="Client testimonials"
                tabIndex={0}
                onKeyDown={onKeyDown}
                onMouseEnter={() => setPaused(true)}
                onMouseLeave={() => setPaused(false)}
                onFocus={() => setPaused(true)}
                onBlur={() => setPaused(false)}
                className="px-6 py-6 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400 rounded-b-2xl"
            >
                <div role="group" aria-roledescription="slide" aria-label={`Testimonial ${index + 1} of ${items.length}`}>
                    <div className="mb-3 flex items-center gap-2 text-xs text-slate-400">
                        <Stars n={current.rating} />
                        <span aria-hidden>·</span>
                        <span>{current.serviceType}</span>
                    </div>
                    <blockquote className="text-slate-200 text-base leading-relaxed" aria-live="polite">
                        &ldquo;{current.quote}&rdquo;
                    </blockquote>
                    <p className="mt-4 text-[10px] text-slate-500 font-mono uppercase tracking-[0.2em]">— Verified Client · {current.ratedAt}</p>
                </div>
                {items.length > 1 && (
                    <div className="mt-5 flex items-center justify-between">
                        <button type="button" onClick={() => setIndex((i) => (i - 1 + items.length) % items.length)} className="px-3 py-1 text-xs text-slate-400 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400 rounded-sm" aria-label="Previous testimonial"><i className="fa-solid fa-chevron-left mr-1" aria-hidden />Prev</button>
                        <span className="text-[10px] text-slate-500 font-mono">{index + 1} / {items.length}</span>
                        <button type="button" onClick={() => setIndex((i) => (i + 1) % items.length)} className="px-3 py-1 text-xs text-slate-400 hover:text-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400 rounded-sm" aria-label="Next testimonial">Next<i className="fa-solid fa-chevron-right ml-1" aria-hidden /></button>
                    </div>
                )}
            </div>
        </CardPanel>
    );
};

// --- Services grid card ---

const ServicesCard: React.FC<{ slug: string; onLogin: () => void }> = ({ slug, onLogin }) => {
    const [items, setItems] = useState<ServiceItem[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetchJson<{ items: ServiceItem[] }>(`/api/public?resource=services&slug=${encodeURIComponent(slug)}`).then((data) => {
            if (!cancelled) setItems(data?.items || []);
        });
        return () => { cancelled = true; };
    }, [slug]);

    if (!items || items.length === 0) return null;

    return (
        <CardPanel as="section" aria-labelledby="services-heading">
            <CardHeader icon="fa-solid fa-briefcase" title="Services Offered" id="services-heading">
                <button onClick={onLogin} className="text-[10px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-sm border border-sky-500/40 text-sky-300 hover:bg-sky-500/10 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400">
                    <i className="fa-solid fa-right-to-bracket mr-1.5" aria-hidden />Log in to Request
                </button>
            </CardHeader>
            <ul className="px-6 py-5 grid grid-cols-1 sm:grid-cols-2 gap-3 list-none">
                {items.map((svc) => (
                    <li key={svc.name} className="p-4 rounded-xl bg-slate-800/40 border border-slate-700/50 hover:border-sky-500/40 transition-colors">
                        <div className="flex items-center gap-3 mb-1.5">
                            {svc.icon && <i className={`${svc.icon} text-lg`} style={{ color: svc.color || '#38bdf8' }} aria-hidden />}
                            <h3 className="text-sm font-bold text-white uppercase tracking-wider">{svc.name}</h3>
                        </div>
                        {svc.description && <p className="text-slate-400 text-xs leading-relaxed">{svc.description}</p>}
                    </li>
                ))}
            </ul>
        </CardPanel>
    );
};

// --- Sidebar: login CTA ---

const LoginCard: React.FC<{ onLogin: () => void }> = ({ onLogin }) => (
    <CardPanel as="aside" aria-labelledby="cta-heading">
        <CardHeader icon="fa-solid fa-shield-halved" title="Join The Network" id="cta-heading" />
        <div className="px-6 py-5">
            <p className="text-slate-400 text-xs mb-4 leading-relaxed">
                Sign in with Discord to submit a service request, join the org, or access restricted areas.
            </p>
            <button
                id="cta-login"
                onClick={onLogin}
                className="w-full flex items-center justify-center bg-[#5865F2] hover:bg-[#4752c4] text-white font-bold py-3 px-5 rounded-xl text-sm transition-all duration-200 shadow-lg shadow-[#5865F2]/25 active:scale-[0.98] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400"
            >
                <i className="fa-solid fa-right-to-bracket h-5 w-5 mr-2.5" aria-hidden />
                <span className="uppercase tracking-wider">Sign In with Discord</span>
            </button>
            <p className="mt-3 text-[10px] text-slate-500 leading-relaxed text-center">
                Uses Discord to authenticate. First time? You&rsquo;ll link your RSI handle next.
            </p>
        </div>
    </CardPanel>
);

// --- Sidebar: stats ---

const StatsCard: React.FC<{ slug: string }> = ({ slug }) => {
    const [stats, setStats] = useState<Stats | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetchJson<Stats>(`/api/public?resource=stats&slug=${encodeURIComponent(slug)}`).then((data) => {
            if (!cancelled) setStats(data);
        });
        return () => { cancelled = true; };
    }, [slug]);

    if (!stats) return null;

    const avgRating = stats.avgRatingTimes10 > 0 ? (stats.avgRatingTimes10 / 10).toFixed(1) : '—';
    const avgResp = stats.avgResponseMinutes > 0
        ? stats.avgResponseMinutes < 60
            ? `${stats.avgResponseMinutes}m`
            : `${Math.round(stats.avgResponseMinutes / 60)}h`
        : '—';

    const rows: Array<{ label: string; value: string; icon: string }> = [
        { label: 'Requests Completed', value: stats.totalCompleted.toLocaleString(), icon: 'fa-solid fa-check-double' },
        { label: 'Avg Client Rating', value: avgRating, icon: 'fa-solid fa-star' },
        { label: 'Avg Response Time', value: avgResp, icon: 'fa-solid fa-stopwatch' },
        { label: 'Completed (30d)', value: stats.last30Completed.toLocaleString(), icon: 'fa-solid fa-calendar-check' },
    ];

    return (
        <CardPanel as="aside" aria-labelledby="stats-heading">
            <CardHeader icon="fa-solid fa-chart-simple" title="At A Glance" id="stats-heading" />
            <dl className="px-6 py-4 space-y-3">
                {rows.map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-3 py-1.5">
                        <dt className="flex items-center gap-2.5 text-xs text-slate-400">
                            <i className={`${row.icon} text-sky-400/70 w-4 text-center`} aria-hidden />
                            <span>{row.label}</span>
                        </dt>
                        <dd className="text-lg font-black text-white font-mono tabular-nums">{row.value}</dd>
                    </div>
                ))}
            </dl>
        </CardPanel>
    );
};

// --- Sidebar: external links ---

const LinksCard: React.FC<{ links: PublicPagePayload['links'] }> = ({ links }) => {
    if (!links || links.length === 0) return null;
    return (
        <CardPanel as="aside" aria-labelledby="links-heading">
            <CardHeader icon="fa-solid fa-link" title="Elsewhere" id="links-heading" />
            <ul className="px-4 py-3 space-y-1.5 list-none">
                {links.map((link) => (
                    <li key={link.id}>
                        <a
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-slate-200 hover:bg-slate-800/60 transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sky-400"
                        >
                            {link.icon && <i className={`${link.icon} w-4 text-center text-sky-400/80`} aria-hidden />}
                            <span className="text-sm font-medium truncate">{link.label}</span>
                            <i className="fa-solid fa-arrow-up-right-from-square text-[10px] text-slate-500 ml-auto" aria-hidden />
                        </a>
                    </li>
                ))}
            </ul>
        </CardPanel>
    );
};

// --- Top-level page ---

const OrgPublicPage: React.FC<{ onLoginClick: () => void }> = ({ onLoginClick }) => {
    const payload = getPayload();
    const slug = useMemo(() => getSlug(), []);
    const [livePayload, setLivePayload] = useState<PublicPagePayload | null>(payload);

    useEffect(() => {
        if (livePayload) return;
        let cancelled = false;
        fetchJson<PublicPagePayload>(`/api/public?resource=page&slug=${encodeURIComponent(slug)}`).then((data) => {
            if (!cancelled && data) setLivePayload(data);
        });
        return () => { cancelled = true; };
    }, [livePayload, slug]);

    if (!livePayload) return null;

    const hasAnyRightColumnContent = true; // LoginCard always renders; stats/links conditional

    return (
        <div className="relative min-h-dvh bg-slate-950 text-slate-200 font-sans overflow-x-hidden animate-fade-in">
            <a href="#cta-login" className="sr-only focus:not-sr-only fixed top-2 left-2 z-50 bg-slate-900 border border-slate-700 text-white text-xs px-3 py-1.5 rounded-sm">Skip to sign in</a>

            {/* Ambient background */}
            <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[800px] h-[500px] bg-sky-500/10 rounded-full blur-[140px] pointer-events-none" aria-hidden />
            <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-size-[40px_40px] pointer-events-none" aria-hidden />

            <main className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Main column */}
                    <div className="lg:col-span-2 space-y-6">
                        <ProfileHeaderCard payload={livePayload} />
                        {livePayload.announcements && livePayload.announcements.length > 0 && (
                            <NoticesCard announcements={livePayload.announcements} />
                        )}
                        {(livePayload.blurb || livePayload.blurbHtml) && (
                            <BlurbCard text={livePayload.blurb} html={livePayload.blurbHtml} />
                        )}
                        {livePayload.modules.testimonials && <TestimonialsCard slug={slug} />}
                        {livePayload.modules.services && <ServicesCard slug={slug} onLogin={onLoginClick} />}
                    </div>

                    {/* Sidebar */}
                    {hasAnyRightColumnContent && (
                        <div className="lg:col-span-1 space-y-6 lg:sticky lg:top-8 lg:self-start">
                            <LoginCard onLogin={onLoginClick} />
                            {livePayload.modules.links && livePayload.links.length > 0 && <LinksCard links={livePayload.links} />}
                            {livePayload.modules.stats && <StatsCard slug={slug} />}
                        </div>
                    )}
                </div>
            </main>

            <footer className="relative z-10 px-5 sm:px-8 py-6 border-t border-white/5 text-center">
                <p className="text-[10px] text-slate-500 font-mono uppercase tracking-[0.25em]">
                    {livePayload.org.name} · Powered by My RSI Org
                </p>
            </footer>
        </div>
    );
};

export default OrgPublicPage;
