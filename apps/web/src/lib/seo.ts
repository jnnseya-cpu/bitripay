import { useEffect } from 'react';

/** Per-page metadata for the SPA: title, description, canonical, Open Graph and JSON-LD. */
export function useMeta(meta: { title: string; description?: string; path?: string; image?: string; jsonLd?: unknown[]; noindex?: boolean }) {
  useEffect(() => {
    const set = (selector: string, attrs: Record<string, string>) => {
      let el = document.head.querySelector<HTMLElement>(selector);
      if (!el) {
        el = document.createElement(selector.startsWith('link') ? 'link' : 'meta');
        document.head.appendChild(el);
      }
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    };
    document.title = meta.title;
    const url = `${window.location.origin}${meta.path ?? window.location.pathname}`;
    if (meta.description) {
      set('meta[name="description"]', { name: 'description', content: meta.description });
      set('meta[property="og:description"]', { property: 'og:description', content: meta.description });
      set('meta[name="twitter:description"]', { name: 'twitter:description', content: meta.description });
    }
    set('meta[property="og:title"]', { property: 'og:title', content: meta.title });
    set('meta[name="twitter:title"]', { name: 'twitter:title', content: meta.title });
    set('meta[property="og:url"]', { property: 'og:url', content: url });
    set('link[rel="canonical"]', { rel: 'canonical', href: url });
    set('meta[name="robots"]', { name: 'robots', content: meta.noindex ? 'noindex,follow' : 'index,follow,max-image-preview:large' });
    if (meta.image) {
      set('meta[property="og:image"]', { property: 'og:image', content: `${window.location.origin}${meta.image}` });
      set('meta[name="twitter:image"]', { name: 'twitter:image', content: `${window.location.origin}${meta.image}` });
    }
    document.head.querySelectorAll('script[data-page-jsonld]').forEach((s) => s.remove());
    for (const item of meta.jsonLd ?? []) {
      const s = document.createElement('script');
      s.type = 'application/ld+json';
      s.dataset.pageJsonld = '1';
      s.text = JSON.stringify(item);
      document.head.appendChild(s);
    }
  }, [meta.title, meta.description, meta.path, meta.image, meta.noindex, JSON.stringify(meta.jsonLd ?? null)]); // eslint-disable-line react-hooks/exhaustive-deps
}
