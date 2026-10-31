import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../cloud/api';
import { ago, useApi } from '../cloud/useApi';
import { IngestKeys } from '../components/IngestKeys';
import { SetupSnippet } from '../components/SetupSnippet';

export function Project() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const project = useApi(() => api.project(projectId), [projectId]);
  const recorders = useApi(() => api.recorders(projectId), [projectId], 10_000);
  const [error, setError] = useState<string | null>(null);

  if (project.error) return <div className="page"><p className="form-error" role="alert">{project.error}</p><Link to="/projects">All projects</Link></div>;
  if (!project.data) return <div className="page"><p className="muted">Loading…</p></div>;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError((err as Error).message); }
  };
  // The viewer shows one recorder at a time, so the header button picks among them, newest data first.
  const byRecent = [...(recorders.data ?? [])].sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  const viewerPath = (key: string) => `/projects/${projectId}/recorders/${encodeURIComponent(key)}/live`;

  return (
    <div className="page">
      <nav className="crumbs"><Link to="/projects">Projects</Link><span>›</span><span>{project.data.name}</span></nav>
      <div className="page-head">
        <h2>{project.data.name}</h2>
        {byRecent.length === 0 && <Link className="button" to={`/projects/${projectId}/connect`}>Connect an app</Link>}
        {byRecent.length === 1 && <Link className="button primary" to={viewerPath(byRecent[0]!.key)}>Open viewer</Link>}
        {byRecent.length > 1 && (
          <details className="menu">
            <summary className="button primary">Open viewer ▾</summary>
            <ul>
              {byRecent.map((r) => (
                <li key={r.key}>
                  <Link to={viewerPath(r.key)}>
                    <code>{r.key}</code>
                    {r.live && <span className="live live-on">● live</span>}
                    <span className="muted">{ago(r.lastSeenAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      <section className="panel-section">
        <h3>Recorders</h3>
        {recorders.data?.length === 0 && <p className="muted">Nothing has been uploaded yet. Add the setup below to your app; recorders show up here once they send data.</p>}
        {!!recorders.data?.length && (
          <table className="table">
            <thead><tr><th>Key</th><th>Sessions</th><th>Last data</th><th /><th /></tr></thead>
            <tbody>
              {recorders.data.map((r) => (
                <tr key={r.key}>
                  <td><Link to={`/projects/${projectId}/recorders/${encodeURIComponent(r.key)}`}><code>{r.key}</code></Link></td>
                  <td>{r.sessions}</td>
                  <td>{ago(r.lastSeenAt)}</td>
                  <td>{r.live && <span className="live live-on">● live</span>}</td>
                  <td><Link className="button" to={viewerPath(r.key)}>Open viewer</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel-section">
        <h3>Setup</h3>
        <SetupSnippet />
      </section>

      <section className="panel-section">
        <h3>Ingest keys</h3>
        <IngestKeys projectId={projectId} onError={setError} />
      </section>

      <section className="panel-section danger">
        <h3>Delete project</h3>
        <p className="muted">Deletes every recorder and recording in it, and its keys stop working.</p>
        <button onClick={() => window.confirm(`Delete ${project.data!.name} and all of its recordings? This can't be undone.`) && act(async () => { await api.deleteProject(projectId); navigate('/projects'); })}>Delete project</button>
      </section>
    </div>
  );
}
