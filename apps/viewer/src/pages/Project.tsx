import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api } from '../cloud/api';
import { ago, useApi } from '../cloud/useApi';
import { IngestKeys } from '../components/IngestKeys';
import { ConnectDialog } from '../components/ConnectDialog';

export function Project() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const project = useApi(() => api.project(projectId), [projectId]);
  const recorders = useApi(() => api.recorders(projectId), [projectId], 10_000);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  // Only a project that was just created opens on the key screen; clearing the state keeps a refresh or a later visit from showing it again.
  const [connect, setConnect] = useState<'key' | 'setup' | null>(() => ((location.state as { connect?: boolean } | null)?.connect ? 'key' : null));
  const [keysVersion, setKeysVersion] = useState(0);
  useEffect(() => {
    if ((location.state as { connect?: boolean } | null)?.connect) navigate(location.pathname, { replace: true, state: null });
  }, [location, navigate]);

  if (project.error) return <div className="page"><p className="form-error" role="alert">{project.error}</p><Link to="/projects">All projects</Link></div>;
  if (!project.data) return <div className="page"><p className="muted">Loading…</p></div>;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError((err as Error).message); }
  };
  const viewerPath = (key: string) => `/projects/${projectId}/recorders/${encodeURIComponent(key)}/live`;

  return (
    <div className="page">
      <nav className="crumbs"><Link to="/projects">Projects</Link><span>›</span><span>{project.data.name}</span></nav>
      <div className="page-head">
        <h2>{project.data.name}</h2>
        <button className="link" onClick={() => setConnect('setup')}>Connect an app</button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      <section className="panel-section">
        <h3>Recorders</h3>
        {recorders.data?.length === 0 && <p className="muted">Nothing has been uploaded yet. Use “Connect an app” to add the setup to your app; recorders show up here once they send data.</p>}
        {!!recorders.data?.length && (
          <table className="table">
            <thead><tr><th>Key</th><th>Last data</th><th /><th /></tr></thead>
            <tbody>
              {recorders.data.map((r) => (
                <tr key={r.key}>
                  <td><Link to={`/projects/${projectId}/recorders/${encodeURIComponent(r.key)}`}><code>{r.key}</code></Link></td>
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
        <h3>Ingest keys</h3>
        <IngestKeys key={keysVersion} projectId={projectId} onError={setError} />
      </section>

      <section className="panel-section danger">
        <h3>Delete project</h3>
        <p className="muted">Deletes every recorder and recording in it, and its keys stop working.</p>
        <button onClick={() => window.confirm(`Delete ${project.data!.name} and all of its recordings? This can't be undone.`) && act(async () => { await api.deleteProject(projectId); navigate('/projects'); })}>Delete project</button>
      </section>
      {connect && <ConnectDialog projectId={projectId} startAt={connect} onClose={() => setConnect(null)} onKeyCreated={() => setKeysVersion((v) => v + 1)} />}
    </div>
  );
}
