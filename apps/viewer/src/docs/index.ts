import { Marked, type Tokens } from 'marked';
import { HOME_SLUG, NAV } from './nav';

/** Every markdown file under the repo's `docs/` folder, keyed by its path. */
const FILES = import.meta.glob('../../../../docs/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export interface DocPage {
  /** Path under `docs/` without `.md`, also the URL under `/docs/`. */
  slug: string;
  /** The page's first `# heading`. */
  title: string;
  /** The markdown after that heading. */
  body: string;
}

export interface Heading { id: string; text: string; depth: number }

export interface RenderedPage { html: string; headings: Heading[] }

const PREFIX = '../../../../docs/';

function parse(path: string, text: string): DocPage {
  const slug = path.slice(PREFIX.length).replace(/\.md$/, '');
  const m = /^#\s+(.+)\n/.exec(text.replace(/^﻿/, ''));
  return { slug, title: m ? m[1]!.trim() : slug, body: m ? text.slice(text.indexOf(m[0]) + m[0].length) : text };
}

export const PAGES: ReadonlyMap<string, DocPage> = new Map(
  Object.entries(FILES).map(([path, text]) => {
    const page = parse(path, text);
    return [page.slug, page];
  }),
);

export const homePage = () => PAGES.get(HOME_SLUG);

/** The markdown pages in sidebar order. */
export const ORDERED: readonly DocPage[] = NAV.flatMap((s) => (s.pages ?? []).map((slug) => PAGES.get(slug)).filter((p): p is DocPage => !!p));

/** A heading's anchor: lowercase words joined by dashes. */
export const slugify = (text: string) =>
  text.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;|&#\d+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * A link written for GitHub (`../concepts/recorders.md#routing`) as the site's URL (`/docs/concepts/recorders#routing`).
 * Links that already point at the site, or elsewhere, are left alone.
 */
export function resolveHref(href: string, fromSlug: string): string {
  if (/^[a-z]+:|^\/|^#/i.test(href)) return href;
  const [path, hash] = href.split('#') as [string, string | undefined];
  if (!path.endsWith('.md')) return href;
  const parts = fromSlug.split('/').slice(0, -1);
  for (const seg of path.replace(/\.md$/, '').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return `/docs/${parts.join('/')}${hash ? `#${hash}` : ''}`;
}

const cache = new Map<string, RenderedPage>();

/** The page as HTML, with ids on its headings and `{{API_URL}}` replaced by the server's address. */
export function render(page: DocPage, apiUrl: string): RenderedPage {
  const key = `${page.slug}\n${apiUrl}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const headings: Heading[] = [];
  const used = new Map<string, number>();
  const md = new Marked({ gfm: true });
  md.use({
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const base = slugify(inner);
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        if (depth === 2 || depth === 3) headings.push({ id, text: inner.replace(/<[^>]+>/g, ''), depth });
        // Pages start at h2 on the site: the title is the page's h2.
        const level = Math.min(depth + 1, 6);
        return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${level}>\n`;
      },
      link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, { href, title, tokens }: Tokens.Link) {
        const to = resolveHref(href, page.slug);
        const external = /^https?:/i.test(to);
        return `<a href="${escapeAttr(to)}"${title ? ` title="${escapeAttr(title)}"` : ''}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${this.parser.parseInline(tokens)}</a>`;
      },
    },
  });
  const html = md.parse(page.body.replaceAll('{{API_URL}}', apiUrl), { async: false }) as string;
  const out = { html, headings };
  cache.set(key, out);
  return out;
}
