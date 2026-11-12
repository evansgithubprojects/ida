import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api } from '../cloud/api';
import { useApi } from '../cloud/useApi';
import { sameLevel, serviceOfProcess, type Level } from '../graph/model';
import { LogoMark } from '../components/Logo';
import { RecorderSwitcher } from '../components/RecorderSwitcher';
import { RecordingsButton, type RecordingSource } from '../components/RecordingsDialog';
import { Replay } from '../components/Replay';
import { useStore } from '../store';

/** How much history the live view opens with (`?span=`, kept from the old system view's links); the server allows at most 24 hours. */
const SPANS = [5, 15, 60, 6 * 60, 24 * 60].map((min) => min * 60_000);
const DEFAULT_SPAN = SPANS[0]!;
const MAX_SPAN = 24 * 60 * 60_000;

/** Stop retrying the live stream after this many failures in a row; the user can retry by hand. */
const MAX_TRIES = 6;

const CLOUD: RecordingSource = { kind: 'cloud' };

/** The zoom level a URL names: `?service=` is that service's processes, `?process=` that process's handlers. */
function levelFromUrl(service: string | null, process: string | null): Level {
  if (process) return { kind: 'handlers', processId: process };
  if (service) return { kind: 'process', service };
  return { kind: 'services' };
}

/** The service a level is inside of, if any. */
function serviceOfLevel(level: Level, index: Parameters<typeof serviceOfProcess>[0]): string | null {
  if (level.kind === 'process') return level.service ?? null;
  if (level.kind === 'handlers') return serviceOfProcess(index, level.processId) ?? null;
  return null;
}

/**
 * The project's viewer: every service at once, live, linked through Kafka and RabbitMQ. Zooming in goes to one
 * service's processes, then a process's handlers; the URL follows, so a link opens at the same zoom. `?run=` shows one
 * past run of a service instead, together with what the other services did meanwhile.
 */
export function ProjectView() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const span = SPANS.some((ms) => String(ms) === params.get('span')) ? Number(params.get('span')) : DEFAULT_SPAN;
  const run = params.get('run');
  const urlService = params.get('service');
  const urlProcess = params.get('process');
  const project = useApi(`project:${projectId}`, () => api.project(projectId));
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const status = useStore((s) => s.live);
  const index = useStore((s) => s.index);
  const level = useStore((s) => s.level);

  // A local file or endpoint only lasts until the project or run changes; it is tagged with what it was chosen on.
  const route = `${projectId}/${run ?? ''}`;
  const [chosen, setChosen] = useState<{ route: string; source: RecordingSource }>({ route, source: CLOUD });
  const source = chosen.route === route ? chosen.source : CLOUD;
  const cloud = source.kind === 'cloud';
  const live = cloud && !run;
  const chooseSource = (next: RecordingSource) => setChosen((c) => (next.kind === 'cloud' && c.source.kind === 'cloud' ? c : { route, source: next }));

  useEffect(() => {
    const { unload } = useStore.getState();
    unload();
    setError(null);
    setTruncated(false);
    return () => unload();
  }, [projectId, run, span, source]);

  // A local file, or a remote endpoint's stream.
  useEffect(() => {
    if (source.kind === 'file') useStore.getState().load(source.recording, source.name);
    else if (source.kind === 'endpoint') useStore.getState().connectLive(source.url, source.url);
  }, [source]);

  // Live: each stream URL is only good for connecting within a minute, so a dropped stream needs a fresh one.
  useEffect(() => {
    if (!live || attempt >= MAX_TRIES) return;
    let alive = true;
    const delay = attempt === 0 ? 0 : Math.min(1000 * 2 ** (attempt - 1), 15_000);
    const t = setTimeout(() => {
      api.projectLiveUrl(projectId, span).then(
        (url) => { if (alive) useStore.getState().connectLive(url, 'all services'); },
        (e: Error) => { if (alive) { setError(e.message); setAttempt((n) => n + 1); } },
      );
    }, delay);
    return () => { alive = false; clearTimeout(t); };
  }, [live, projectId, span, attempt]);

  useEffect(() => {
    if (!live) return;
    if (status === 'on') { setError(null); setAttempt(0); }
    // EventSource gives up for good on an auth failure; reconnect with a new token.
    if (status === 'error') setAttempt((n) => n + 1);
  }, [live, status]);

  // A past run: its own span of time, with every service that was recording then.
  useEffect(() => {
    if (!cloud || !run) return;
    if (!urlService) { setError('A run needs the service it belongs to (?service=).'); return; }
    let alive = true;
    (async () => {
      const found = (await api.sessions(projectId, urlService)).find((s) => s.id === run);
      if (!found) throw new Error('That run was not found. It may have been deleted.');
      const to = Math.max(new Date(found.lastSeenAt).getTime(), found.startedAt + 1);
      const from = Math.max(found.startedAt, to - MAX_SPAN);
      const { recording, ...rest } = await api.system(projectId, from, to);
      if (!alive) return;
      setTruncated(rest.truncated);
      useStore.getState().load(recording, `${urlService} · ${new Date(found.startedAt).toLocaleString()}`, rest);
    })().catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [cloud, run, projectId, urlService]);

  // The URL and the zoom level follow each other once a system view is on screen. Until then the URL's level waits.
  // URL -> zoom: on load, and on Back / Forward.
  const system = !!index?.system;
  useEffect(() => {
    if (!system) return;
    const want = levelFromUrl(urlService, urlProcess);
    const { level: now, setLevel } = useStore.getState();
    if (!sameLevel(want, now)) setLevel(want);
  }, [system, urlService, urlProcess]);
  // Zoom -> URL: only when the zoom itself changes, and only after the URL's level has been applied once, so the
  // level a recording opens at doesn't overwrite the one the link asked for.
  const synced = useRef(false);
  const lastLevel = useRef(level);
  useEffect(() => {
    if (!system) { synced.current = false; return; }
    if (!synced.current) {
      synced.current = sameLevel(level, levelFromUrl(urlService, urlProcess));
      lastLevel.current = level;
      return;
    }
    if (lastLevel.current === level) return;
    lastLevel.current = level;
    const service = serviceOfLevel(level, index);
    const process = level.kind === 'handlers' ? level.processId : null;
    if (service === urlService && process === urlProcess) return;
    // Each zoom step is a history entry, so Back steps out again.
    setParams((p) => {
      if (service) p.set('service', service); else p.delete('service');
      if (process) p.set('process', process); else p.delete('process');
      return p;
    });
  }, [system, level, index, urlService, urlProcess, setParams]);

  const service = system ? serviceOfLevel(level, index) : urlService;
  const pick = (key: string | null) => {
    if (system) useStore.getState().setLevel(key ? { kind: 'process', service: key } : { kind: 'services' });
    else setParams((p) => { if (key) p.set('service', key); else p.delete('service'); p.delete('process'); return p; });
  };
  const backToLive = () => setParams((p) => { p.delete('run'); return p; });

  const view = index?.system;
  const links = view ? [...view.links.values()] : [];
  const missing = links.filter((l) => l.status === 'missing').length;
  const skewed = links.filter((l) => l.skewMs !== undefined).length;
  const gaps = index?.recording.gaps?.reduce((n, g) => n + g.dropped, 0) ?? 0;

  return (
    <div className="app">
      <header className="toolbar">
        <Link className="home-mark" to="/" aria-label="Ida home"><LogoMark /></Link>
        <nav className="crumbs">
          <Link to={project.data ? `/orgs/${project.data.orgId}` : '/projects'}>Projects</Link><span>›</span>
          <Link to={`/projects/${projectId}`}>{project.data?.name ?? 'Project'}</Link>
          {source.kind === 'file' && <><span>›</span><span>Local file · {source.name}</span></>}
          {source.kind === 'endpoint' && <><span>›</span><span>Endpoint · {source.url}</span></>}
          {cloud && run && <><span>›</span><span>Run of <code>{urlService}</code></span></>}
        </nav>
        <span className="spacer" />
        {view && <span className="muted">{view.services.size} service{view.services.size === 1 ? '' : 's'}</span>}
        {live && status !== 'on' && attempt >= MAX_TRIES && <button onClick={() => setAttempt(0)}>Reconnect</button>}
      </header>
      {error && <div className="banner" role="alert">{error}</div>}
      {truncated && (
        <div className="banner banner-warn" role="status">
          This run holds more events than one view shows, so only the newest are here.
        </div>
      )}
      {gaps > 0 && (
        <div className="banner banner-warn" role="status">
          {gaps} events were lost while an app was offline and its spool was full. They are marked on the timeline.
        </div>
      )}
      {(missing > 0 || skewed > 0) && (
        <div className="banner banner-warn" role="status">
          {missing > 0 && `${missing} consumed message${missing === 1 ? ' names a publisher' : 's name publishers'} Ida has no record of: the service that sent ${missing === 1 ? 'it' : 'them'} isn't recorded. `}
          {skewed > 0 && `${skewed} message${skewed === 1 ? ' was' : 's were'} consumed before ${skewed === 1 ? 'it was' : 'they were'} published, by the services' clocks; inspect one to see by how much.`}
        </div>
      )}
      <Replay
        corner={<RecorderSwitcher projectId={projectId} service={cloud ? service : null} source={source} onSource={chooseSource} onPick={pick} />}
        exit={run || source.kind === 'file' ? (
          <button className="danger" onClick={() => (source.kind === 'file' ? chooseSource(CLOUD) : backToLive())}>Exit</button>
        ) : undefined}
        actions={<RecordingsButton projectId={projectId} recorderKey={cloud ? service : null} currentSessionId={run ?? undefined} source={source} onSource={chooseSource} />}
        empty={(
          <div className="welcome">
            {source.kind === 'endpoint' ? (
              <>
                <h2>{status === 'on' ? 'Waiting for events…' : status === 'error' ? 'Could not connect' : 'Connecting…'}</h2>
                <p>Events from <code>{source.url}</code> appear here as the endpoint sends them.</p>
              </>
            ) : live ? (
              <>
                <h2>{status === 'on' ? 'Waiting for events…' : 'Connecting…'}</h2>
                <p>Services show up here as they upload events. <Link to={`/projects/${projectId}`}>Connect an app</Link> to start.</p>
              </>
            ) : <h2>{error ? 'Could not load this run' : 'Loading…'}</h2>}
          </div>
        )}
      />
    </div>
  );
}
