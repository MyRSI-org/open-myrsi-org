import React, { useState } from 'react';

// Branding fields the splash needs — subset of BrandingConfig, kept minimal so
// it can be satisfied by the SSR-injected window.__BRANDING__ JSON.
export interface BootSplashBranding {
    name?: string;
    iconUrl?: string;
}

interface BootSplashProps {
    /** Full branding config when rendered inside DashboardApp. */
    branding?: BootSplashBranding;
    /** When true, shows the "first time / still waiting" helper message. */
    showExtendedWait?: boolean;
    /** When true, falls back to a generic platform splash (no org name / logo). */
    genericFallback?: boolean;
}

declare global {
    interface Window {
        __BRANDING__?: BootSplashBranding;
    }
}

// Module-level memo of logo URLs that have already loaded once this page-load.
// BootSplash is mounted in several subtrees (App Suspense fallback, the
// DashboardApp boot gate, the wizard Suspense fallback) and React unmounts one
// and mounts the next as boot advances. Without this, every remount resets
// iconLoaded to false and the logo re-fades in from the spinner — the visible
// boot "flash". Seeding iconLoaded from this set keeps the logo painted across
// remounts of the same URL.
const loadedIcons = new Set<string>();

const resolveBranding = (provided?: BootSplashBranding): BootSplashBranding => {
    if (provided && (provided.name || provided.iconUrl)) return provided;
    if (typeof window !== 'undefined' && window.__BRANDING__) return window.__BRANDING__;
    return {};
};

/**
 * Shared branded boot splash. Used in three places to keep paint consistent:
 *   1. SSR-rendered markup injected into the HTML shell for tenant subdomains
 *   2. React Suspense fallback while the DashboardApp chunk downloads
 *   3. Inside DashboardApp while auth + data bootstrap
 *
 * Same visual state across all phases — no progress bar animation, no step
 * ticker, just a clean branded splash with an indeterminate sweep bar. This
 * eliminates the intermediate flashes users previously saw as the splash
 * re-rendered with different UI variants.
 */
const BootSplash: React.FC<BootSplashProps> = ({ branding, showExtendedWait, genericFallback }) => {
    const resolved = genericFallback ? {} : resolveBranding(branding);
    const displayName = resolved.name || 'Operations Terminal';
    const iconUrl = resolved.iconUrl;
    const [iconLoaded, setIconLoaded] = useState(() => !!iconUrl && loadedIcons.has(iconUrl));

    return (
        <div className="fixed inset-0 h-dvh w-screen bg-slate-950 flex flex-col items-center justify-center overflow-hidden z-9999">
            {/* Scanline overlay */}
            <div className="absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-size-[100%_4px,3px_100%] pointer-events-none"></div>
            {/* Radial vignette */}
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,var(--tw-gradient-stops))] from-slate-800/20 via-slate-950 to-slate-950"></div>

            <div className="relative z-10 w-full max-w-md p-8 flex flex-col items-center">
                {/* Icon / spinner */}
                <div className="relative mb-10">
                    <div className="absolute inset-0 bg-sky-500 blur-3xl opacity-20 animate-pulse rounded-full"></div>
                    <div className="relative z-10 w-20 h-20 flex items-center justify-center">
                        {iconUrl ? (
                            <>
                                <img
                                    src={iconUrl}
                                    alt=""
                                    onLoad={() => { if (iconUrl) loadedIcons.add(iconUrl); setIconLoaded(true); }}
                                    className={`w-20 h-20 transition-opacity duration-500 drop-shadow-[0_0_15px_rgba(14,165,233,0.8)] ${iconLoaded ? 'opacity-100' : 'opacity-0 absolute'}`}
                                />
                                {!iconLoaded && <i className="fa-solid fa-circle-notch text-white text-5xl animate-spin"></i>}
                            </>
                        ) : (
                            <i className="fa-solid fa-circle-notch text-white text-5xl animate-spin"></i>
                        )}
                    </div>
                </div>

                {/* Org name / title */}
                <h1 className="text-3xl sm:text-4xl font-black text-white tracking-[0.2em] mb-2 text-center uppercase">
                    {displayName}
                    <br /><span className="text-sky-500 text-base sm:text-lg tracking-[0.5em]">TERMINAL</span>
                </h1>
                <div className="h-px w-32 bg-linear-to-r from-transparent via-sky-500 to-transparent mb-8 opacity-50"></div>

                {/* Indeterminate sweep — same visual throughout all phases */}
                <p className="text-xs text-sky-400 font-mono uppercase tracking-[0.3em] mb-5 flex items-center gap-3">
                    <i className="fa-solid fa-satellite-dish animate-spin-slow text-sky-500/80"></i>
                    <span className="animate-pulse">Establishing Uplink...</span>
                </p>
                <div className="w-48 bg-slate-900/80 rounded-full h-1.5 overflow-hidden border border-slate-700/50">
                    <div className="h-full w-2/5 bg-linear-to-r from-transparent via-sky-500/80 to-transparent rounded-full" style={{ animation: 'splashSweep 1.5s ease-in-out infinite' }}></div>
                </div>

                {showExtendedWait && (
                    <div className="w-full flex flex-col items-center gap-3 mt-8 animate-fade-in">
                        <div className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 bg-sky-500 rounded-full animate-pulse"></span>
                            <span className="w-1.5 h-1.5 bg-sky-500 rounded-full animate-pulse" style={{ animationDelay: '0.3s' }}></span>
                            <span className="w-1.5 h-1.5 bg-sky-500 rounded-full animate-pulse" style={{ animationDelay: '0.6s' }}></span>
                        </div>
                        <p className="text-[11px] text-slate-500 font-mono text-center leading-relaxed">
                            First time loading may take a moment.<br />
                            <span className="text-slate-600">Please stand by.</span>
                        </p>
                    </div>
                )}
            </div>

            <div className="absolute bottom-8 text-[10px] text-slate-600 font-mono uppercase tracking-[0.3em] text-center px-4">
                {resolved.name ? `${resolved.name} // Termlink v15.1.2-open` : 'Termlink v15.1.2-open'}
            </div>

            <style>{`@keyframes splashSweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }`}</style>
        </div>
    );
};

/**
 * Effect helper: once React has mounted and is ready to render real content,
 * remove the SSR-rendered splash placeholder from the DOM.
 */
export const dismissSSRSplash = () => {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('__boot_splash__');
    if (el && el.parentNode) el.parentNode.removeChild(el);
};

export default BootSplash;
