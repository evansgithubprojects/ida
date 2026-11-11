import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../cloud/api';
import { rememberRecorder } from '../cloud/lastRecorder';
import { useApi } from '../cloud/useApi';
import { LogoMark } from '../components/Logo';
import { RecorderSwitcher } from '../components/RecorderSwitcher';
import { RecordingsButton, type RecordingSource } from '../components/RecordingsDialog';
import { Replay } from '../components/Replay';
import { useStore } from '../store';

/** Stop retrying the live stream after this many failures in a row; the user can retry by hand. */
const MAX_TRIES = 6;

const CLOUD: RecordingSource = { kind: 'cloud' };

/** How often a live view asks again where its broker messages went. */
const PEERS_EVERY_MS = 5000;

/** One recorded session, or (with `live`) the recorder's newest session as it grows. */
export function Session({ live = false }: { live?: boolean }) {
  const { projectId = '', recorderKey = '', sessionId = '' } = useParams();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const navigate = useNavigate();
  const status = useStore((s) => s.live);
  const index = useStore((s) => s.index);
  const project = useApi(`project:${projectId}`, () => api.project(projectId));
  // A local file or endpoint only lasts until the route changes; it is tagged with the route it was chosen on.
  const route = `${projectId}/${recorderKey}/${sessionId}/${live}`;
  const [chosen, setChosen] = useState<{ route: string; source: RecordingSource }>({ route, source: CLOUD });
  const source = chosen.route === route ? chosen.source : CLOUD;
  const cloud = source.kind === 'cloud';
  const chooseSource = (next: RecordingSource) => setChosen((c) => (next.kind === 'cloud' && c.source.kind === 'cloud' ? c : { route, source: next }));

  useEffect(() => { rememberRecorder(projectId, recorderKey); }, [projectId, recorderKey]);

  useEffect(() => {
    const { unload } = useStore.getState();
    unload();
    setError(null);
    return () => unload();
  }, [projectId, recorderKey, sessionId, live, source]);

  // A local file, or a remote endpoint's stream.
  useEffect(() => {
    if (source.kind === 'file') useStore.getState().load(source.recording, source.name);
    else if (source.kind === 'endpoint') useStore.getState().connectLive(source.url, source.url);
  }, [source]);

  // A saved session loads once.
  useEffect(() => {
    if (!cloud || live) return;
    let alive = true;
    api.recording(sessionId).then(
      (rec) => { if (alive) useStore.getState().load(rec, `${recorderKey} · ${new Date(rec.startedAt).toLocaleString()}`); },
      (e: Error) => { if (alive) setError(e.message); },
    );
    return () => { alive = false; };
  }, [cloud, live, sessionId, recorderKey]);

  // Live: each stream URL is only good for connecting within a minute, so a dropped stream needs a fresh one.
  useEffect(() => {
    if (!cloud || !live || attempt >= MAX_TRIES) return;
    let alive = true;
    const delay = attempt === 0 ? 0 : Math.min(1000 * 2 ** (attempt - 1), 15_000);
    const t = setTimeout(() => {
      api.liveUrl(projectId, recorderKey).then(
        (url) => { if (alive) useStore.getState().connectLive(url, recorderKey); },
        (e: Error) => { if (alive) { setError(e.message); setAttempt((n) => n + 1); } },
      );
    }, delay);
    return () => { alive = false; clearTimeout(t); };
  }, [cloud, live, projectId, recorderKey, attempt]);

  // Where this service's Kafka and RabbitMQ messages came from and went to. Live, the other services keep consuming,
  // so it is fetched again every few seconds.
  useEffect(() => {
    if (!cloud) return;
    let alive = true;
    const fetch = () => (live ? api.recorderPeers(projectId, recorderKey) : api.sessionPeers(sessionId)).then(
      (peers) => { if (alive) useStore.getState().setPeers(peers); },
      () => { /* only extra context: the view works without it */ },
    );
    void fetch();
    const timer = live ? setInterval(fetch, PEERS_EVERY_MS) : undefined;
    return () => { alive = false; clearInterval(timer); };
  }, [cloud, live, projectId, recorderKey, sessionId]);

  useEffect(() => {
    if (!cloud || !live) return;
    if (status === 'on') { setError(null); setAttempt(0); }
    // EventSource gives up for good on an auth failure; reconnect with a new token.
    if (status === 'error') setAttempt((n) => n + 1);
  }, [cloud, live, status]);

  return (
    <div className="app">
      <header className="toolbar">
        <Link className="home-mark" to="/" aria-label="Ida home"><LogoMark /></Link>
        <nav className="crumbs">
          <Link to={project.data ? `/orgs/${project.data.orgId}` : '/projects'}>Projects</Link><span>›</span>
          <Link to={`/projects/${projectId}`}>{project.data?.name ?? 'Project'}</Link><span>›</span>
          <code>{recorderKey}</code>
          {source.kind === 'file' && <><span>›</span><span>Local file · {source.name}</span></>}
          {source.kind === 'endpoint' && <><span>›</span><span>Endpoint · {source.url}</span></>}
          {cloud && !live && <><span>›</span><span>Recording</span></>}
        </nav>
        <span className="spacer" />
        {cloud && live && status !== 'on' && attempt >= MAX_TRIES && <button onClick={() => setAttempt(0)}>Reconnect</button>}
      </header>
      {error && <div className="banner" role="alert">{error}</div>}
      {index?.recording.gaps?.length ? (
        <div className="banner banner-warn" role="status">
          {index.recording.gaps.reduce((n, g) => n + g.dropped, 0)} events were lost while the app was offline and its spool was full. They are marked on the timeline.
        </div>
      ) : null}
      <Replay
        corner={<RecorderSwitcher projectId={projectId} recorderKey={recorderKey} source={source} onSource={chooseSource} />}
        exit={!live || source.kind === 'file' ? (
          <button className="danger" onClick={() => (live ? chooseSource(CLOUD) : navigate(`/projects/${projectId}/recorders/${encodeURIComponent(recorderKey)}/live`))}>
            Exit
          </button>
        ) : undefined}
        actions={<RecordingsButton projectId={projectId} recorderKey={recorderKey} currentSessionId={live ? undefined : sessionId} source={source} onSource={chooseSource} />}
        empty={(
          <div className="welcome">
            {source.kind === 'endpoint' ? (
              <>
                <h2>{status === 'on' ? 'Waiting for events…' : status === 'error' ? 'Could not connect' : 'Connecting…'}</h2>
                <p>Events from <code>{source.url}</code> appear here as the endpoint sends them.</p>
              </>
            ) : live && cloud ? (
              <>
                <h2>{status === 'on' ? 'Waiting for events…' : 'Connecting…'}</h2>
                <p>Events from <code>{recorderKey}</code> appear here as your app sends them.</p>
              </>
            ) : <h2>{error ? 'Could not load this recording' : 'Loading…'}</h2>}
          </div>
        )}
      />
    </div>
  );
}
