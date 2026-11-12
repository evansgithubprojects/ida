import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, SOURCES } from '../src/components/SetupSnippet';
import { blockLanguages, forLanguage, languageFor, LANG_BLOCK, PAGES, render, resolveHref, type DocPage } from '../src/docs';
import { DOC_LANGUAGES, HOME_SLUG, MOVED, NAV } from '../src/docs/nav';

const ROOT = join(__dirname, '../../..');
const DOCS = join(ROOT, 'docs');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const files = walk(DOCS).filter((f) => f.endsWith('.md')).map((f) => relative(DOCS, f).replace(/\.md$/, '').split('\\').join('/'));
const navSlugs = NAV.flatMap((s) => s.pages ?? []);
const integrations = new Set<string>(SOURCES.map((s) => s.id));

/** A page in each of its languages (or once, without any), as HTML. */
const variants = (p: DocPage) => (p.languages.length ? p.languages : [undefined]).map((l) => render(p, 'https://api.example', l).html);
/** Each page's HTML in all its languages together: anchors and links from any of them count. */
const rendered = new Map([...PAGES.values()].map((p) => [p.slug, { html: variants(p).join('\n') }]));
const idsOf = (html: string) => new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!));

/** Where a site link (`/docs/x#y`) points, or why it doesn't resolve. */
function checkLink(href: string): string | null {
  const [path, hash] = href.replace(/^\/docs\/?/, '').split('#') as [string, string | undefined];
  const slug = path.split('?')[0]!.replace(/\/$/, '') || HOME_SLUG;
  if (integrations.has(slug)) return hash ? `anchor on integration page ${slug}` : null;
  const page = rendered.get(slug);
  if (!page) return `no page ${slug}`;
  if (hash && !idsOf(page.html).has(hash)) return `no heading #${hash} on ${slug}`;
  return null;
}

describe('docs', () => {
  it('lists every markdown file in the sidebar exactly once', () => {
    expect(new Set(navSlugs).size).toBe(navSlugs.length);
    expect([...navSlugs].sort()).toEqual([...files].sort());
    expect(PAGES.has(HOME_SLUG)).toBe(true);
  });

  it('starts every page with a title, and no page shadows an integration page', () => {
    for (const f of files) {
      expect(read(`docs/${f}.md`), f).toMatch(/^# \S/);
      expect(integrations.has(f), f).toBe(false);
    }
  });

  it('turns GitHub-style links into site links', () => {
    expect(resolveHref('../concepts/recorders.md#routing', 'quickstart/node')).toBe('/docs/concepts/recorders#routing');
    expect(resolveHref('python.md', 'reference/core')).toBe('/docs/reference/python');
    expect(resolveHref('/docs/kafka?lang=python', 'overview')).toBe('/docs/kafka?lang=python');
    expect(resolveHref('https://kafka.js.org', 'overview')).toBe('https://kafka.js.org');
    expect(resolveHref('quickstart.md?lang=python#2-get-an-ingest-key', 'overview')).toBe('/docs/quickstart?lang=python#2-get-an-ingest-key');
  });

  describe('language blocks', () => {
    const md = 'Shared.\n\n:::lang node,browser\nJS only.\n:::\n\n:::lang python\nPython only.\n:::\n\nShared again.\n';

    it('keeps only the chosen language', () => {
      expect(forLanguage(md, 'browser')).toBe('Shared.\n\nJS only.\n\n\nShared again.\n');
      expect(forLanguage(md, 'python')).toBe('Shared.\n\n\nPython only.\n\nShared again.\n');
      expect(forLanguage(md, undefined)).toBe('Shared.\n\n\n\nShared again.\n');
    });

    it('uses the same language ids as the setup snippets and integration pages', () => {
      expect(DOC_LANGUAGES.map((l) => l.id)).toEqual(LANGUAGES.map((l) => l.id));
    });

    it('falls back to the page\'s first language', () => {
      const page = PAGES.get('guides/naming')!;
      expect(page.languages).toEqual(['node', 'browser', 'python']);
      expect(languageFor(page, 'python')).toBe('python');
      expect(languageFor(page, 'cobol')).toBe('node');
    });

    it('names only known languages, and leaves no unclosed block behind', () => {
      const known = new Set<string>(DOC_LANGUAGES.map((l) => l.id));
      for (const page of PAGES.values()) {
        for (const list of blockLanguages(page.body)) for (const l of list) expect(known.has(l), `${page.slug}: ${l}`).toBe(true);
        expect(page.body.replace(LANG_BLOCK, ''), page.slug).not.toMatch(/^:::/m);
      }
    });

    // A page that declares its languages is one guide in several languages: every step must say something in each.
    it('covers every declared language in each section that has language blocks', () => {
      const gaps: string[] = [];
      for (const page of [...PAGES.values()].filter((p) => p.declared)) {
        const sections = page.body.split(/^(?=## )/m);
        for (const section of sections) {
          const named = new Set(blockLanguages(section).flat());
          if (!named.size) continue;
          const title = /^## (.+)/.exec(section)?.[1] ?? '(intro)';
          for (const l of page.languages) if (!named.has(l)) gaps.push(`${page.slug} › ${title}: no ${l}`);
        }
      }
      expect(gaps).toEqual([]);
    });

    it('sends old quick start links to the merged page, in their language', () => {
      for (const [from, [to, lang]] of Object.entries(MOVED)) {
        expect(PAGES.has(from), from).toBe(false);
        expect(PAGES.get(to)?.languages, from).toContain(lang);
      }
    });
  });

  it('has no broken links or anchors between pages', () => {
    const broken: string[] = [];
    for (const [slug, { html }] of rendered) {
      const own = idsOf(html);
      for (const [, href] of html.matchAll(/<a href="([^"]+)"/g)) {
        const h = href!.replace(/&amp;/g, '&');
        if (h.startsWith('#')) { if (!own.has(h.slice(1))) broken.push(`${slug}: ${h}`); continue; }
        if (/^https?:/.test(h)) continue;
        if (!h.startsWith('/docs')) { broken.push(`${slug}: ${h} (links outside the docs must be absolute URLs)`); continue; }
        const why = checkLink(h);
        if (why) broken.push(`${slug}: ${h} (${why})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('links the integration pages to pages that exist', () => {
    const links = [...read('apps/viewer/src/pages/Docs.tsx').matchAll(/to: '(\/docs\/[^']+)'/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    expect(links.map((l) => [l, checkLink(l)]).filter(([, why]) => why)).toEqual([]);
  });

  it('only fills in the {{API_URL}} placeholder', () => {
    for (const f of files) {
      const left = read(`docs/${f}.md`).replaceAll('{{API_URL}}', '').match(/\{\{[^}]*\}\}/g);
      expect(left, f).toBeNull();
    }
  });

  describe('code samples import only what the packages export', () => {
    const ENTRIES: Record<string, string[]> = {
      '@ida-dev/core': ['packages/core/src/index.ts'],
      '@ida-dev/core/bridge-node': ['packages/core/src/bridge-node.ts'],
      '@ida-dev/cloud': ['packages/cloud/src/node.ts'],
      '@ida-dev/adapter-eventemitter': ['packages/adapter-eventemitter/src/index.ts'],
      '@ida-dev/adapter-eventtarget': ['packages/adapter-eventtarget/src/index.ts'],
      '@ida-dev/adapter-kafkajs': ['packages/adapter-kafkajs/src/index.ts'],
      '@ida-dev/adapter-amqplib': ['packages/adapter-amqplib/src/index.ts'],
    };

    /** Every name a module exports, following `export *` and re-exports. */
    function exportsOf(file: string, seen = new Set<string>()): Set<string> {
      const names = new Set<string>();
      if (seen.has(file)) return names;
      seen.add(file);
      const src = read(file);
      for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]!);
      for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
        for (const part of m[1]!.split(',')) {
          const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
          if (name) names.add(name);
        }
      }
      for (const m of src.matchAll(/export\s+\*\s+from\s+'(\.[^']+)'/g)) {
        for (const n of exportsOf(join(dirname(file), `${m[1]}.ts`).replace(`${ROOT}/`, ''), seen)) names.add(n);
      }
      return names;
    }

    const imports = files.flatMap((f) =>
      [...read(`docs/${f}.md`).matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'(@ida-dev\/[^']+)'/g)].map((m) => ({
        page: f,
        pkg: m[2]!,
        names: m[1]!.split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim()).filter(Boolean),
      })),
    );

    it('finds samples to check', () => expect(imports.length).toBeGreaterThan(10));

    it.each(Object.keys(ENTRIES))('%s', (pkg) => {
      const exported = new Set(ENTRIES[pkg]!.flatMap((f) => [...exportsOf(f)]));
      const missing = imports.filter((i) => i.pkg === pkg).flatMap((i) => i.names.filter((n) => !exported.has(n)).map((n) => `${i.page}: ${n}`));
      expect(missing).toEqual([]);
    });

    it('names no package that does not exist', () => {
      const unknown = imports.filter((i) => !ENTRIES[i.pkg]).map((i) => `${i.page}: ${i.pkg}`);
      expect(unknown).toEqual([]);
    });
  });
});
