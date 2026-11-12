import { useEffect, useMemo, useRef } from 'react';
import { Link, Navigate, NavLink, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { API_URL } from '../cloud/supabase';
import { SETUPS, SOURCES, languagesFor, type Source } from '../components/SetupSnippet';
import { languageFor, PAGES, render, type DocPage } from '../docs';
import { DOC_LANGUAGES, HOME_SLUG, MOVED, NAV } from '../docs/nav';

/** What a broker integration records and how it links services, beyond the setup itself. */
const BROKER_NOTES: Partial<Record<Source, string[]>> = {
  kafka: [
    'Each produce is recorded on its topic, emitted by the handler that was running, and adds an ida-parent header to the message.',
    'Each consumed message is recorded on its topic, handled by your code, and linked through that header to the produce in whichever service sent it, in any language.',
    'Topic, partition, offset and consumer group are kept with every message. Message keys are kept only when you turn on recordKeys (record_keys in Python).',
  ],
  rabbitmq: [
    'Each publish is recorded on its exchange and adds an ida-parent header to the message properties. Your own properties object is never changed.',
    'Each delivery is recorded on its queue, handled by your callback, and linked through that header to the publish in whichever service sent it, in any language.',
    'Exchange, routing key, queue and delivery tag are kept with every message.',
  ],
};

/** Where to read more after an integration's setup. */
const INTEGRATION_LINKS: Record<Source, { to: string; label: string }[]> = {
  eventemitter: [
    { to: '/docs/reference/adapter-eventemitter', label: 'EventEmitter adapter reference' },
    { to: '/docs/guides/what-gets-recorded', label: 'Choose what gets recorded' },
  ],
  eventtarget: [{ to: '/docs/reference/adapter-eventtarget', label: 'EventTarget adapter reference' }],
  kafka: [
    { to: '/docs/guides/brokers', label: 'Tracing messages across services' },
    { to: '/docs/reference/adapter-kafkajs', label: 'kafkajs adapter reference' },
    { to: '/docs/reference/python#ida-adapters-kafka', label: 'Python Kafka reference' },
  ],
  rabbitmq: [
    { to: '/docs/guides/brokers', label: 'Tracing messages across services' },
    { to: '/docs/reference/adapter-amqplib', label: 'amqplib adapter reference' },
    { to: '/docs/reference/python#ida-adapters-rabbitmq', label: 'Python RabbitMQ reference' },
  ],
};

interface Entry { slug: string; title: string }

/** Every sidebar entry in order, markdown pages and integration pages alike, for previous / next links. */
const ENTRIES: { section: string; entries: Entry[] }[] = NAV.map((s) => ({
  section: s.title,
  entries: s.integrations
    ? SOURCES.map((src) => ({ slug: src.id, title: src.label }))
    : (s.pages ?? []).flatMap((slug) => {
        const p = PAGES.get(slug);
        return p ? [{ slug, title: p.title }] : [];
      }),
}));
const FLAT = ENTRIES.flatMap((s) => s.entries);

/** Where the language picked last is remembered, so every docs page opens in it. */
const LANG_KEY = 'ida.docs.lang';
const storedLanguage = () => { try { return localStorage.getItem(LANG_KEY); } catch { return null; } };
const storeLanguage = (id: string) => { try { localStorage.setItem(LANG_KEY, id); } catch { /* private mode: the URL still carries it */ } };

/**
 * The language docs pages show: `?lang=` when the URL names one, else the one picked last on any page. One choice
 * drives the quick start, every page with language blocks, and the integration pages. `choose` puts it in the URL,
 * so the link can be shared, and remembers it.
 */
function useDocLanguage() {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('lang');
  const wanted = fromUrl ?? storedLanguage();
  // A language arriving by link becomes the remembered one too, as long as the docs know it.
  useEffect(() => {
    if (fromUrl && DOC_LANGUAGES.some((l) => l.id === fromUrl)) storeLanguage(fromUrl);
  }, [fromUrl]);
  const choose = (id: string) => {
    storeLanguage(id);
    setParams((p) => { p.set('lang', id); return p; }, { replace: true });
  };
  return { wanted, choose };
}

/** Tabs for the languages a page comes in. */
function LanguagePicker({ languages, current, onPick }: { languages: readonly { id: string; label: string }[]; current?: string; onPick(id: string): void }) {
  if (languages.length < 2) return null;
  return (
    <div className="tabs docs-lang" role="tablist" aria-label="Language">
      {languages.map((l) => (
        <button key={l.id} role="tab" aria-selected={current === l.id} className={current === l.id ? 'current' : ''} onClick={() => onPick(l.id)}>
          {l.label}
        </button>
      ))}
    </div>
  );
}

/** `/docs` and `/docs/<page>`: the sidebar, then a markdown page or an integration's setup. */
export function Docs() {
  const slug = useParams()['*']?.replace(/\/$/, '') || HOME_SLUG;
  const { hash } = useLocation();
  const moved = MOVED[slug];
  if (moved) return <Navigate to={`/docs/${moved[0]}?lang=${moved[1]}${hash}`} replace />;
  const page = PAGES.get(slug);
  const source = SOURCES.find((s) => s.id === slug);
  const at = FLAT.findIndex((e) => e.slug === slug);

  return (
    <div className="page docs docs-layout">
      <DocsSidebar current={slug} />
      <div className="docs-main">
        {page ? <MarkdownPage page={page} /> : source ? <IntegrationPage source={source.id} /> : (
          <>
            <h2>No page called “{slug}”</h2>
            <p><Link to="/docs">Back to the docs</Link></p>
          </>
        )}
        {at >= 0 && <PrevNext prev={FLAT[at - 1]} next={FLAT[at + 1]} />}
      </div>
    </div>
  );
}

function DocsSidebar({ current }: { current: string }) {
  const navigate = useNavigate();
  return (
    <nav className="docs-nav" aria-label="Docs">
      {/* On narrow screens the list collapses into this picker. */}
      <select className="docs-nav-select" aria-label="Go to page" value={current} onChange={(e) => navigate(`/docs/${e.target.value}`)}>
        {ENTRIES.map((s) => (
          <optgroup key={s.section} label={s.section}>
            {s.entries.map((e) => <option key={e.slug} value={e.slug}>{e.title}</option>)}
          </optgroup>
        ))}
      </select>
      <div className="docs-nav-list">
        {ENTRIES.map((s) => (
          <div key={s.section} className="docs-nav-section">
            <h4>{s.section}</h4>
            <ul>
              {s.entries.map((e) => (
                <li key={e.slug}>
                  <NavLink to={`/docs/${e.slug}`} className={e.slug === current ? 'current' : ''} aria-current={e.slug === current ? 'page' : undefined} end>
                    {e.title}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}

function MarkdownPage({ page }: { page: DocPage }) {
  const { wanted, choose } = useDocLanguage();
  const language = languageFor(page, wanted);
  const { html, headings } = useMemo(() => render(page, API_URL, language), [page, language]);
  const navigate = useNavigate();
  const { hash } = useLocation();
  const body = useRef<HTMLDivElement>(null);

  // A new page starts at its top, or at the heading its link names.
  useEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [page, hash]);

  // Links to other docs pages navigate in the app instead of reloading it.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target) return;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('/')) {
      e.preventDefault();
      navigate(href);
    }
  };

  const toc = headings.filter((h) => h.depth === 2);
  return (
    <div className="docs-article-wrap">
      <article className="docs-article">
        <h2>{page.title}</h2>
        <LanguagePicker languages={DOC_LANGUAGES.filter((l) => page.languages.includes(l.id))} current={language} onPick={choose} />
        <div ref={body} className="doc-body" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      </article>
      {toc.length > 2 && (
        <nav className="docs-toc" aria-label="On this page">
          <h4>On this page</h4>
          <ul>{toc.map((h) => <li key={h.id}><a href={`#${h.id}`}>{h.text}</a></li>)}</ul>
        </nav>
      )}
    </div>
  );
}

function PrevNext({ prev, next }: { prev?: Entry; next?: Entry }) {
  return (
    <nav className="docs-prevnext" aria-label="Previous and next page">
      {prev ? <Link to={`/docs/${prev.slug}`} className="prev"><small>Previous</small>{prev.title}</Link> : <span />}
      {next ? <Link to={`/docs/${next.slug}`} className="next"><small>Next</small>{next.title}</Link> : <span />}
    </nav>
  );
}

/** Setup for one event source in the language picked (`?lang=`). */
function IntegrationPage({ source: id }: { source: Source }) {
  const { wanted, choose } = useDocLanguage();
  const source = SOURCES.find((s) => s.id === id)!;
  const languages = languagesFor(id);
  // An unknown or unsupported language falls back to the source's first.
  const language = languages.find((l) => l.id === wanted) ?? languages[0];
  useEffect(() => { window.scrollTo(0, 0); }, [id]);

  return (
    <article className="docs-article">
      <h2>{source.label}</h2>
      <p className="lede">{source.blurb}</p>
      <p className="muted">
        Make an ingest key in your project first, and set it as <code>IDA_PROJECT_KEY</code>. Uploads go to <code>{API_URL}</code>.
      </p>
      <LanguagePicker languages={languages} current={language?.id} onPick={choose} />
      {language && (() => {
        const setup = SETUPS[language.id][id]!;
        return (
          <section className="panel-section" role={languages.length > 1 ? 'tabpanel' : undefined}>
            <h3>{language.label}{setup.library && <span className="muted"> · {setup.library}</span>}</h3>
            <pre className="snippet">{`${setup.install}\n\n${setup.code('ida_…', API_URL)}`}</pre>
            {setup.example && (
              <>
                <h4>Then publish and consume as usual</h4>
                <pre className="snippet">{setup.example}</pre>
              </>
            )}
          </section>
        );
      })()}
      {BROKER_NOTES[id] && (
        <section className="panel-section">
          <h3>What is recorded</h3>
          <ul>{BROKER_NOTES[id]!.map((n) => <li key={n}>{n}</li>)}</ul>
          <p className="muted">Open your project's viewer to see every service together, with each message drawn from the service that sent it to the one that handled it.</p>
        </section>
      )}
      <section className="panel-section">
        <h3>Read more</h3>
        <ul>{INTEGRATION_LINKS[id].map((l) => <li key={l.to}><Link to={l.to}>{l.label}</Link></li>)}</ul>
      </section>
    </article>
  );
}

/** One card per event source, linking to its docs page, with the languages that support it. */
export function IntegrationGrid() {
  return (
    <div className="feature-grid">
      {SOURCES.map((s) => (
        <Link key={s.id} to={`/docs/${s.id}`} className="feature integration">
          <h4>{s.label}</h4>
          <p>{s.blurb}</p>
          <p className="muted">{languagesFor(s.id).map((l) => l.label).join(' · ')}</p>
        </Link>
      ))}
    </div>
  );
}
