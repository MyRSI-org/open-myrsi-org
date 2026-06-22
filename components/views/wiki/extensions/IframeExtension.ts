import { Node, mergeAttributes } from '@tiptap/core';
// Single source of truth for the embed host allow-list, shared with the server-side
// sanitizer (lib/tiptapValidate enforces it at the write boundary too). (api-1/fe-3)
import { ALLOWED_EMBED_HOSTS } from '../../../../lib/tiptapValidate';

export interface IframeOptions {
    allowFullscreen: boolean;
    HTMLAttributes: Record<string, any>;
}

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        iframe: {
            setIframe: (options: { src: string; width?: string; height?: string }) => ReturnType;
        };
    }
}

function isAllowedIframeSrc(src: string | null): boolean {
    if (!src) return false;
    try {
        const url = new URL(src);
        if (url.protocol !== 'https:') return false;
        return ALLOWED_EMBED_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
    } catch {
        return false;
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
                    sandbox: 'allow-scripts allow-same-origin allow-popups',
                    allowfullscreen: this.options.allowFullscreen,
                    style: `width: ${HTMLAttributes.width || '100%'}; height: ${HTMLAttributes.height || '400px'}; border: 1px solid rgba(100, 116, 139, 0.3); border-radius: 0.5rem;`,
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
