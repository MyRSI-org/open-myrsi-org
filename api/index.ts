
import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { getAnnouncementsState } from '../lib/db.js';
import { tryParseTiptapJson, tiptapJsonToSafeHtml, isEmptyTiptapDoc } from '../lib/tiptapValidate.js';
import { sanitizePublicLinkUrl } from '../lib/linkUrl.js';
import { sanitizeImageUrl } from '../lib/imageUrl.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log as baseLog } from '../lib/log.js';

const log = baseLog.child({ module: 'api.index' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Compiled location: dist-server/api/index.js → up two levels to reach project root, then into dist/
const distPath = path.resolve(__dirname, '../../dist');

// Read index.html from disk once at startup — always fresh after redeployment
let cachedIndexHtml: string | null = null;
function getIndexHtml(): string {
    if (!cachedIndexHtml) {
        cachedIndexHtml = fs.readFileSync(path.join(distPath, 'index.html'), 'utf-8');
    }
    return cachedIndexHtml;
}

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(supabaseUrl, supabaseKey);

export function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escape a value for safe use as JSON inside an inline <script>: handle </script>
// breakout and HTML-comment tricks (< > &), plus the line/paragraph separators
// U+2028/U+2029 (legal in JSON but not in JS strings on older engines). One place
// for the window.__BRANDING__ / window.__PUBLIC_PAGE__ injection.
export function escapeJsonForScript(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export default async function handler(req: Request, res: Response) {
    try {
        let title: string;
        let description: string;
        let image: string;
        let themeColor: string;
        let siteName: string;
        // `linkIconUrl` is the tab/PWA-install glyph (<link rel="icon"> /
        // apple-touch-icon), overridable via the OG faviconUrl. `splashIconUrl`
        // is the boot-splash hero (<img> + window.__BRANDING__) and always uses
        // the org's proper Logo URL, never the small favicon override.
        let linkIconUrl: string;
        let splashIconUrl: string;
        let publicPageCfg: any = null;
        let setupCompletedFlag = false;

        // Single-org: branding / OG / public-page come straight from the settings table.
        {
            const { data: settings } = await supabase
                .from('settings')
                .select('key, value')
                .in('key', ['brandingConfig', 'openGraphConfig', 'publicPageConfig', 'setup_completed']);

            const config: any = settings?.reduce((acc, curr) => ({ ...acc, [curr.key]: curr.value }), {}) || {};
            const og = config.openGraphConfig || {};
            const branding = config.brandingConfig || {};
            publicPageCfg = config.publicPageConfig || null;
            // Gate the PWA service worker on first-run completion (read by pwa-init.js).
            // During onboarding the SW must not control navigations / the OAuth callback.
            setupCompletedFlag = config.setup_completed === true;

            title = og.title || branding.name || 'Operations Dashboard';
            description = og.description || 'Secure Operations Terminal';
            image = og.imageUrl || '/icon.svg';
            themeColor = og.themeColor || branding.themeColor || '#0f172a';
            siteName = branding.name || 'Dashboard';
            linkIconUrl = og.faviconUrl || branding.iconUrl || '/icon.svg';
            splashIconUrl = branding.iconUrl || '/icon.svg';
        }

        // Read static index.html from disk (avoids a self-referential fetch
        // through the CDN, which served stale HTML with outdated chunk hashes).
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host;

        let html = getIndexHtml();

        // Inject metadata via regex replacement.
        const replaceTag = (htmlContent: string, tagType: string, attrName: string, attrValue: string, contentValue: string) => {
            const regex = new RegExp(`<${tagType}[^>]*${attrName}=["']${attrValue}["'][^>]*>`, 'i');
            const replacement = `<${tagType} ${attrName}="${attrValue}" content="${escapeHtml(contentValue)}" />`;

            if (regex.test(htmlContent)) {
                return htmlContent.replace(regex, replacement);
            }
            return htmlContent.replace('</head>', `${replacement}\n</head>`);
        };

        html = html.replace(/<title>.*?<\/title>/i, `<title>${escapeHtml(title)}</title>`);

        html = replaceTag(html, 'meta', 'name', 'description', description);
        html = replaceTag(html, 'meta', 'name', 'theme-color', themeColor);
        html = replaceTag(html, 'meta', 'name', 'apple-mobile-web-app-title', siteName);

        html = replaceTag(html, 'meta', 'property', 'og:title', title);
        html = replaceTag(html, 'meta', 'property', 'og:description', description);
        html = replaceTag(html, 'meta', 'property', 'og:image', image);
        html = replaceTag(html, 'meta', 'property', 'og:site_name', siteName);
        html = replaceTag(html, 'meta', 'property', 'og:url', `${protocol}://${host}`);

        html = replaceTag(html, 'meta', 'name', 'twitter:card', 'summary_large_image');
        html = replaceTag(html, 'meta', 'name', 'twitter:title', title);
        html = replaceTag(html, 'meta', 'name', 'twitter:description', description);
        html = replaceTag(html, 'meta', 'name', 'twitter:image', image);

        // Remove any static manifest link so the dynamic /api/manifest wins
        // (the static manifest.json often takes precedence over rewrites).
        html = html.replace(/<link[^>]*rel=["']manifest["'][^>]*>/gi, '');

        // Hard-replace existing icon links to ensure correctness.
        html = html.replace(/<link[^>]*rel=["']icon["'][^>]*>/gi, '');
        html = html.replace(/<link[^>]*rel=["']apple-touch-icon["'][^>]*>/gi, '');

        // Build manifest URL: must be same-origin as the document so that
        // start_url, scope, and shortcut URLs resolve correctly for PWA install.
        const manifestHref = '/api/manifest';

        // Inject new links — the favicon/apple-touch-icon use linkIconUrl,
        // which honors the OG faviconUrl override.
        const safeLinkIconUrl = escapeHtml(linkIconUrl);
        const headLinks = `
            <link rel="manifest" href="${manifestHref}">
            <link rel="icon" href="${safeLinkIconUrl}">
            <link rel="apple-touch-icon" href="${safeLinkIconUrl}">
        `;
        html = html.replace('</head>', `${headLinks}\n</head>`);

        // Inject a pre-rendered boot splash so the browser paints a branded
        // loading screen instantly, before any React chunks download. Also
        // inject window.__BRANDING__ so the React BootSplash renders identical
        // markup when it takes over.
        {
            const safeName = escapeHtml(siteName);
            // The boot splash and window.__BRANDING__ should always show the
            // org's proper Logo URL — never the small favicon override.
            const safeSplashIconUrl = escapeHtml(splashIconUrl);
            const safeBrandingJson = escapeJsonForScript({ name: siteName, iconUrl: splashIconUrl });

            // Build the public page payload (only when admin has enabled it).
            // featuredTestimonialIds are INTENTIONALLY excluded — the client only
            // receives the resolved anonymized testimonials via /api/public.
            let publicPageScript = '';
            if (publicPageCfg && publicPageCfg.enabled === true) {
                // Re-validate link schemes/hosts on the SSR projection too
                // (mirrors lib/db/public.ts) — the write gate is not the only
                // line of defense for the unauthenticated page.
                const allowedLinks = Array.isArray(publicPageCfg.links)
                    ? publicPageCfg.links
                        .filter((l: any) => l && typeof l.id === 'string' && typeof l.label === 'string' && typeof l.url === 'string')
                        .map((l: any) => ({ l, safeUrl: sanitizePublicLinkUrl(l.url) }))
                        .filter((x: { safeUrl: string | null }) => !!x.safeUrl)
                        .slice(0, 10)
                        .map(({ l, safeUrl }: { l: any; safeUrl: string }) => ({
                            id: l.id,
                            label: l.label,
                            url: safeUrl,
                            ...(typeof l.icon === 'string' && l.icon ? { icon: l.icon } : {}),
                        }))
                    : [];

                // Public page mirrors the org's login screen — surface the same
                // 'Login Screen'-audience announcements (filtered, newest-first).
                let announcementsForPublic: Array<{
                    id: string; title: string; body: string; author: string;
                    type: string; audience: string[]; publishDate: string; expiryDate?: string;
                }> = [];
                try {
                    const { announcements: rawAnnouncements } = await getAnnouncementsState();
                    const nowMs = Date.now();
                    announcementsForPublic = rawAnnouncements
                        .filter(a => Array.isArray(a.audience) && a.audience.includes('Login Screen'))
                        .filter(a => !a.expiryDate || (Date.parse(a.expiryDate) || 0) > nowMs)
                        .map(a => ({
                            id: a.id,
                            title: a.title,
                            body: a.body,
                            author: a.author,
                            type: a.type,
                            audience: a.audience,
                            publishDate: a.publishDate,
                            ...(a.expiryDate ? { expiryDate: a.expiryDate } : {}),
                        }));
                    // db helper already sorts publish_date desc, but enforce in case the source query order ever shifts.
                    announcementsForPublic.sort((a, b) =>
                        (Date.parse(b.publishDate) || 0) - (Date.parse(a.publishDate) || 0),
                    );
                } catch {
                    announcementsForPublic = [];
                }

                // Convert Tiptap-JSON blurb to safe HTML server-side so the
                // SSR-injected payload matches what /api/public?resource=page
                // returns; otherwise the client renders the literal JSON. Empty
                // docs (cleared editor) are suppressed so the "About" card hides
                // cleanly via the client's `(blurb || blurbHtml)` truthy check.
                const rawBlurb = typeof publicPageCfg.blurb === 'string' ? publicPageCfg.blurb : '';
                const parsedBlurb = tryParseTiptapJson(rawBlurb);
                const blurbIsEmpty = parsedBlurb
                    ? isEmptyTiptapDoc(parsedBlurb)
                    : rawBlurb.trim().length === 0;
                const blurbHtml = parsedBlurb && !blurbIsEmpty ? tiptapJsonToSafeHtml(parsedBlurb, 'minimal') : '';
                const blurbText = parsedBlurb || blurbIsEmpty ? '' : rawBlurb;

                const publicPayload = {
                    enabled: true,
                    org: { name: siteName, iconUrl: splashIconUrl },
                    motto: typeof publicPageCfg.motto === 'string' ? publicPageCfg.motto : '',
                    blurb: blurbText,
                    blurbHtml,
                    heroImageUrl: sanitizeImageUrl(publicPageCfg.heroImageUrl) || '',
                    profileImageUrl: sanitizeImageUrl(publicPageCfg.profileImageUrl) || '',
                    modules: {
                        stats: !!publicPageCfg.modules?.stats,
                        testimonials: !!publicPageCfg.modules?.testimonials,
                        services: !!publicPageCfg.modules?.services,
                        links: !!publicPageCfg.modules?.links,
                    },
                    links: allowedLinks,
                    announcements: announcementsForPublic,
                };
                publicPageScript = `;window.__PUBLIC_PAGE__=${escapeJsonForScript(publicPayload)}`;
            }

            const splashHtml = `
<div id="__boot_splash__" style="position:fixed;inset:0;height:100dvh;width:100vw;background:#020617;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;z-index:9999;font-family:ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased;color:#cbd5e1">
  <div style="position:absolute;inset:0;background-image:linear-gradient(rgba(18,16,16,0) 50%,rgba(0,0,0,0.25) 50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06));background-size:100% 4px,3px 100%;pointer-events:none"></div>
  <div style="position:absolute;inset:0;background:radial-gradient(ellipse at center,rgba(30,41,59,0.2),#020617 60%,#020617)"></div>
  <div style="position:relative;z-index:10;display:flex;flex-direction:column;align-items:center;padding:2rem;max-width:28rem;width:100%">
    <div style="position:relative;margin-bottom:2.5rem;width:5rem;height:5rem;display:flex;align-items:center;justify-content:center">
      <div style="position:absolute;inset:0;background:#0ea5e9;filter:blur(48px);opacity:0.2;border-radius:9999px;animation:__bsPulse 2s ease-in-out infinite"></div>
      <img id="__bs_icon__" src="${safeSplashIconUrl}" alt="" style="position:relative;z-index:1;width:5rem;height:5rem;filter:drop-shadow(0 0 15px rgba(14,165,233,0.8))"/>
    </div>
    <h1 style="font-size:1.875rem;font-weight:900;color:#fff;letter-spacing:0.2em;text-transform:uppercase;text-align:center;margin:0 0 0.5rem">${safeName}<br/><span style="color:#0ea5e9;font-size:1rem;letter-spacing:0.5em">TERMINAL</span></h1>
    <div style="height:1px;width:8rem;background:linear-gradient(to right,transparent,#0ea5e9,transparent);opacity:0.5;margin-bottom:2rem"></div>
    <div style="display:flex;align-items:center;gap:0.75rem;font-family:ui-monospace,monospace;font-size:0.75rem;color:#38bdf8;text-transform:uppercase;letter-spacing:0.3em;margin-bottom:1.5rem">
      <span style="animation:__bsPulse 2s ease-in-out infinite">Establishing Uplink...</span>
    </div>
    <div style="width:12rem;background:rgba(15,23,42,0.8);border-radius:9999px;height:0.375rem;overflow:hidden;border:1px solid rgba(51,65,85,0.5)">
      <div style="height:100%;width:40%;background:linear-gradient(to right,transparent,rgba(14,165,233,0.8),transparent);border-radius:9999px;animation:__bsSweep 1.5s ease-in-out infinite"></div>
    </div>
    <p style="margin-top:1.5rem;font-size:0.625rem;color:#475569;font-family:ui-monospace,monospace;text-align:center">First time visits may take a moment.</p>
  </div>
  <div style="position:absolute;bottom:2rem;font-size:0.625rem;color:#475569;font-family:ui-monospace,monospace;text-transform:uppercase;letter-spacing:0.3em;text-align:center;padding:0 1rem">${safeName} // Termlink v15.2.0-open</div>
  <style>@keyframes __bsSweep{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}@keyframes __bsPulse{0%,100%{opacity:1}50%{opacity:0.5}}</style>
</div>
<script>(function(){var i=document.getElementById('__bs_icon__');if(i){i.onerror=function(){this.style.display='none';};}})();window.__BRANDING__=${safeBrandingJson};window.__SETUP_COMPLETED__=${setupCompletedFlag}${publicPageScript}</script>`;

            html = html.replace('<div id="root"></div>', `<div id="root"></div>${splashHtml}`);
        }

        // Stamp the per-request CSP nonce (set by server.ts) onto every <script>
        // tag. The injected inline branding script requires it now that
        // script-src dropped 'unsafe-inline'; other scripts receiving it is
        // harmless. style="" needs no nonce (style-src is still 'unsafe-inline').
        const cspNonce: string = res.locals.cspNonce || '';
        if (cspNonce) {
            html = html.replace(/<script/g, `<script nonce="${cspNonce}"`);
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('CDN-Cache-Control', 'no-store');
        return res.send(html);

    } catch (error) {
        log.error('ssr injection failed', { err: error });
        return res.redirect(302, '/index.html');
    }
}
