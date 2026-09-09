import { Node, mergeAttributes } from '@tiptap/core';
// Single source of truth for the embed host allow-list, shared with the server-side
// sanitizer (lib/tiptapValidate enforces the same predicate at the write boundary).
// (api-1/fe-3)
import { isAllowedIframeSrc } from '../../../../lib/embedHosts';

export interface IframeOptions {
    allowFullscreen: boolean;
    HTMLAttributes: Record<string, any>;
}

/**
 * A CSS LENGTH, or the default — never whatever the document said.
 *
 * `width` and `height` are author-controlled attributes on a wiki node, and
 * renderHTML interpolates them straight into a `style` string. Anything containing
 * a `;` therefore stops being a length and becomes additional declarations:
 *
 *     width = "100%; position: fixed; top: 0; left: 0; z-index: 9999"
 *
 * paints an allow-listed third-party iframe over the entire viewport of every page
 * that embed appears on. The host allow-list is not the control here — the frame is
 * from a permitted host; the injection is in the geometry.
 *
 * Deliberately an ALLOW-list of shapes rather than an escape: a bare number, or a
 * number with one of the four units this embed can meaningfully use. Anything else
 * falls back to the default, so a malformed value renders a normal embed rather
 * than a broken one.
 */
const CSS_LENGTH_RE = /^\d{1,4}(\.\d{1,2})?(px|%|vw|vh|em|rem)?$/;
export function safeCssLength(value: unknown, fallback: string): string {
    const v = String(value ?? '').trim();
    return CSS_LENGTH_RE.test(v) ? v : fallback;
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        iframe: {
            setIframe: (options: { src: string; width?: string; height?: string }) => ReturnType;
        };
    }
}

export const IframeExtension = Node.create<IframeOptions>({
    name: 'iframe',

    group: 'block',

    atom: true,

    addOptions() {
        return {
            allowFullscreen: true,
            HTMLAttributes: {
                class: 'wiki-iframe-wrapper',
            },
        };
    },

    addAttributes() {
        return {
            src: { default: null },
            width: { default: '100%' },
            height: { default: '400px' },
        };
    },

    parseHTML() {
        return [{ tag: 'iframe' }];
    },

    renderHTML({ HTMLAttributes }) {
        if (!isAllowedIframeSrc(HTMLAttributes.src)) {
            return ['div', { class: 'wiki-iframe-blocked' }, 'Embed blocked: URL not in the allowed sources list.'];
        }

        return [
            'div',
            mergeAttributes(this.options.HTMLAttributes),
            [
                'iframe',
                mergeAttributes(HTMLAttributes, {
                    // allow-scripts + allow-same-origin are required for the allow-listed
                    // embeds (video/docs) to function. allow-popups is dropped: rendering
                    // never needs it, and it removes a popup-based redirect/phishing vector
                    // from framed content. The host allow-list (ALLOWED_IFRAME_HOSTS) remains
                    // the primary control over what may be framed at all.
                    sandbox: 'allow-scripts allow-same-origin',
                    allowfullscreen: this.options.allowFullscreen,
                    // Coerced, not interpolated — see safeCssLength. This is the single
                    // point where the style string is built, so validating here covers
                    // every path that can produce one (the command, a paste, an import).
                    style: `width: ${safeCssLength(HTMLAttributes.width, '100%')}; height: ${safeCssLength(HTMLAttributes.height, '400px')}; border: 1px solid rgba(100, 116, 139, 0.3); border-radius: 0.5rem;`,
                }),
            ],
        ];
    },

    addCommands() {
        return {
            setIframe:
                (options) =>
                ({ commands }) => {
                    if (!isAllowedIframeSrc(options.src)) {
                        console.warn('Iframe blocked: URL not in allowed sources list:', options.src);
                        return false;
                    }
                    return commands.insertContent({
                        type: this.name,
                        attrs: options,
                    });
                },
        };
    },
});

export default IframeExtension;
