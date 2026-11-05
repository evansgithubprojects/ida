import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../cloud/api';
import { useApi } from '../cloud/useApi';
import { LogoMark } from '../components/Logo';
import { RecorderSwitcher } from '../components/RecorderSwitcher';
import { Replay } from '../components/Replay';
import { useStore } from '../store';

/** Stop retrying the live stream after this many failures in a row; the user can retry by hand. */
const MAX_TRIES = 6;

/** One recorded session, or (with `live`) the recorder's newest session as it grows. */
export function Session({ live = false }: { live?: boolean }) {
  const { projectId = '', recorderKey = '', sessionId = '' } = useParams();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const status = useStore((s) => s.live);
  const index = useStore((s) => s.index);
  const project = useApi(() => api.project(projectId), [projectId]);
  const base = `/projects/${projectId}/recorders/${encodeURIComponent(recorderKey)}`;

  useEffect(() => {
    const { unload } = useStore.getState();
    unload();
    setError(null);
    return () => unload();
  }, [projectId, recorderKey, sessionId, live]);

  // A saved session loads once.
  useEffect(() => {
    if (live) return;
    let alive = true;
    api.recording(sessionId).then(
      (rec) => { if (alive) useStore.getState().load(rec, `${recorderKey} · ${new Date(rec.startedAt).toLocaleString()}`); },
      (e: Error) => { if (alive) setError(e.message); },
    );
    return () => { alive = false; };
  }, [live, sessionId, recorderKey]);

  // Live: each stream URL is only good for connecting within a minute, so a dropped stream needs a fresh one.
  useEffect(() => {
    if (!live || attempt >= MAX_TRIES) return;
    let alive = true;
    const delay = attempt === 0 ? 0 : Math.min(1000 * 2 ** (attempt - 1), 15_000);
    const t = setTimeout(() => {
      api.liveUrl(projectId, recorderKey).then(
        (url) => { if (alive) useStore.getState().connectLive(url, recorderKey); },
        (e: Error) => { if (alive) { setError(e.message); setAttempt((n) => n + 1); } },
      );
    }, delay);
    return () => { alive = false; clearTimeout(t); };
  }, [live, projectId, recorderKey, attempt]);

  useEffect(() => {
    if (!live) return;
    if (status === 'on') { setError(null); setAttempt(0); }
    // EventSource gives up for good on an auth failure; reconnect with a new token.
    if (status === 'error') setAttempt((n) => n + 1);
  }, [live, status]);

  return (
    <div className="app">
      <header className="toolbar">
        <Link className="home-mark" to="/" aria-label="Ida home"><LogoMark /></Link>
        <nav className="crumbs">
          <Link to="/projects">Projects</Link><span>›</span>
          <Link to={`/projects/${projectId}`}>{project.data?.name ?? 'Project'}</Link><span>›</span>
          <Link to={base}><code>{recorderKey}</code></Link><span>›</span>
          <span>{live ? 'Live' : 'Recording'}</span>
        </nav>
        <span className="spacer" />
        {live && status !== 'on' && attempt >= MAX_TRIES && <button onClick={() => setAttempt(0)}>Reconnect</button>}
      </header>
      {error && <div className="banner" role="alert">{error}</div>}
      {index?.recording.gaps?.length ? (
        <div className="banner banner-warn" role="status">
          {index.recording.gaps.reduce((n, g) => n + g.dropped, 0)} events were lost while the app was offline and its spool was full. They are marked on the timeline.
        </div>
      ) : null}
      <Replay
        corner={<RecorderSwitcher projectId={projectId} recorderKey={recorderKey} />}
        empty={(
          <div className="welcome">
            {live ? (
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
