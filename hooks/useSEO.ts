
import { useEffect } from 'react';

interface SEOConfig {
    title?: string;
    description?: string;
    image?: string;
    url?: string;
}

export function useSEO(config: SEOConfig) {
    const { title, description, image, url } = config;

    useEffect(() => {
        if (title) {
            document.title = title;
        }

        const updateMeta = (selector: string, attribute: string, value: string) => {
            if (!value) return;
            let element = document.querySelector(selector);
            if (!element) {
                element = document.createElement('meta');

                // Handle different attribute types for selector creation vs setting
                if (selector.startsWith('meta[name=')) {
                    element.setAttribute('name', selector.replace('meta[name="', '').replace('"]', ''));
                } else if (selector.startsWith('meta[property=')) {
                    element.setAttribute('property', selector.replace('meta[property="', '').replace('"]', ''));
                }

                document.head.appendChild(element);
            }
            element.setAttribute(attribute, value);
        };

        if (description) updateMeta('meta[name="description"]', 'content', description);

        // Open Graph (Facebook/Discord)
        if (title) updateMeta('meta[property="og:title"]', 'content', title);
        if (description) updateMeta('meta[property="og:description"]', 'content', description);
        if (image) updateMeta('meta[property="og:image"]', 'content', image);
        if (url) updateMeta('meta[property="og:url"]', 'content', url);
        updateMeta('meta[property="og:type"]', 'content', 'website');

        // Twitter Card
        updateMeta('meta[name="twitter:card"]', 'content', 'summary_large_image');
        if (title) updateMeta('meta[name="twitter:title"]', 'content', title);
        if (description) updateMeta('meta[name="twitter:description"]', 'content', description);
        if (image) updateMeta('meta[name="twitter:image"]', 'content', image);

    }, [title, description, image, url]);
}
