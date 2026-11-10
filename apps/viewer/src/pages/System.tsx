import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../cloud/api';
import { useApi } from '../cloud/useApi';
import { LogoMark } from '../components/Logo';
import { Replay } from '../components/Replay';
import type { SystemView } from '../replay/system';
import { useStore } from '../store';

/** How far back the view reaches; the server allows at most 24 hours. */
const SPANS = [
  { label: 'Last 5 minutes', ms: 5 * 60_000 },
  { label: 'Last 15 minutes', ms: 15 * 60_000 },
  { label: 'Last hour', ms: 60 * 60_000 },
  { label: 'Last 6 hours', ms: 6 * 60 * 60_000 },
  { label: 'Last 24 hours', ms: 24 * 60 * 60_000 },
];
const DEFAULT_SPAN = SPANS[1]!.ms;

/**
 * Every service of a project in one wall-clock window: each recorder's sessions merged into one recording, with
 * messages that crossed Kafka or RabbitMQ linked from the service that published them to the one that consumed them.
 */
export function SystemPage() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const span = SPANS.some((s) => String(s.ms) === params.get('span')) ? Number(params.get('span')) : DEFAULT_SPAN;
  const project = useApi(`project:${projectId}`, () => api.project(projectId));
  const [view, setView] = useState<Omit<SystemView, 'recording'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const { unload } = useStore.getState();
    unload();
    return () => unload();
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    const to = Date.now();
    setLoading(true);
    setError(null);
    api.system(projectId, to - span, to).then(
      ({ recording, ...rest }) => {
        if (!alive) return;
        setView(rest);
        if (recording.occurrences.length) useStore.getState().load(recording, `System · ${new Date(rest.from).toLocaleTimeString()} to ${new Date(rest.to).toLocaleTimeString()}`, rest);
        else useStore.getState().unload();
      },
      (e: Error) => { if (alive) setError(e.message); },
    ).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, span, version]);

  const services = new Set(view?.services.map((s) => s.recorderKey)).size;
  const missing = view?.links.filter((l) => l.status === 'missing').length ?? 0;
  const skewed = view?.links.filter((l) => l.skewMs !== undefined).length ?? 0;

  return (
    <div className="app">
      <header className="toolbar">
        <Link className="home-mark" to="/" aria-label="Ida home"><LogoMark /></Link>
        <nav className="crumbs">
          <Link to={project.data ? `/orgs/${project.data.orgId}` : '/projects'}>Projects</Link><span>›</span>
          <Link to={`/projects/${projectId}`}>{project.data?.name ?? 'Project'}</Link><span>›</span>
          <span>System</span>
        </nav>
        <span className="spacer" />
        {view && <span className="muted">{services} service{services === 1 ? '' : 's'}</span>}
        <select
          aria-label="Time window"
          value={span}
          onChange={(e) => setParams((p) => { p.set('span', e.target.value); return p; }, { replace: true })}
        >
          {SPANS.map((s) => <option key={s.ms} value={s.ms}>{s.label}</option>)}
        </select>
        <button onClick={() => setVersion((v) => v + 1)} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </header>
      {error && <div className="banner" role="alert">{error}</div>}
      {view?.truncated && (
        <div className="banner banner-warn" role="status">
          This window holds more events than one view shows, so only the newest are here. Pick a shorter window to see the rest.
        </div>
      )}
      {(missing > 0 || skewed > 0) && (
        <div className="banner banner-warn" role="status">
          {missing > 0 && `${missing} consumed message${missing === 1 ? ' names a publisher' : 's name publishers'} Ida has no record of: the service that sent ${missing === 1 ? 'it' : 'them'} isn't recorded. `}
          {skewed > 0 && `${skewed} message${skewed === 1 ? ' was' : 's were'} consumed before ${skewed === 1 ? 'it was' : 'they were'} published, by the services' clocks; inspect one to see by how much.`}
        </div>
      )}
      <Replay
        empty={(
          <div className="welcome">
            {error ? <h2>Could not load the system view</h2>
              : !view || loading ? <h2>Loading…</h2>
              : (
                <>
                  <h2>Nothing recorded in this window</h2>
                  <p>Services show up here once they upload events. Pick a longer window, or <Link to={`/projects/${projectId}`}>connect an app</Link>.</p>
                </>
              )}
          </div>
        )}
      />
    </div>
  );
}
