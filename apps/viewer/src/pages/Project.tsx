import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { api } from '../cloud/api';
import { recorderToOpen } from '../cloud/lastRecorder';
import { canInProject, rememberOrg } from '../cloud/orgs';
import { ago, useApi } from '../cloud/useApi';
import { IngestKeys } from '../components/IngestKeys';
import { ConnectDialog } from '../components/ConnectDialog';
import { ProjectAccess } from '../components/ProjectAccess';
import { ProjectSkeleton, TableSkeleton } from '../components/Skeleton';

export function Project() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const project = useApi(`project:${projectId}`, () => api.project(projectId));
  const recorders = useApi(`recorders:${projectId}`, () => api.recorders(projectId), { pollMs: 10_000 });
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  // Only a project that was just created opens on the key screen; clearing the state keeps a refresh or a later visit from showing it again.
  const [connect, setConnect] = useState<'key' | 'setup' | null>(() => ((location.state as { connect?: boolean } | null)?.connect ? 'key' : null));
  const [keysVersion, setKeysVersion] = useState(0);
  useEffect(() => {
    if ((location.state as { connect?: boolean } | null)?.connect) navigate(location.pathname, { replace: true, state: null });
  }, [location, navigate]);

  useEffect(() => { if (project.data) rememberOrg(project.data.orgId); }, [project.data]);

  if (project.error) return <div className="page"><p className="form-error" role="alert">{project.error}</p><Link to="/projects">All projects</Link></div>;
  if (!project.data) return <ProjectSkeleton />;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError((err as Error).message); }
  };
  // Without a role from the server, show the least: the server refuses the rest anyway.
  const access = project.data.access ?? 'viewer';
  const manageKeys = canInProject.manageKeys(access);
  const administer = canInProject.administer(access);
  const openKey = recorders.data ? recorderToOpen(projectId, recorders.data) : null;

  return (
    <div className="page">
      <nav className="crumbs"><Link to={`/orgs/${project.data.orgId}`}>Projects</Link><span>›</span><span>{project.data.name}</span></nav>
      <div className="page-head">
        <h2>{project.data.name}</h2>
        <div className="page-actions">
          {manageKeys && <button className="link" onClick={() => setConnect('setup')}>Connect an app</button>}
          {openKey && <Link className="button primary" to={`/projects/${projectId}/recorders/${encodeURIComponent(openKey)}/live`} title={`Opens ${openKey}`}>Open viewer</Link>}
        </div>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      <section className="panel-section">
        <h3>Recorders</h3>
        {!recorders.data && !recorders.error && <TableSkeleton heads={['Key', 'Last data']} rows={2} />}
        {recorders.data?.length === 0 && (
          <p className="muted">{manageKeys
            ? 'Nothing has been uploaded yet. Use “Connect an app” to add the setup to your app; recorders show up here once they send data.'
            : 'Nothing has been uploaded yet. Recorders show up here once the app sends data.'}</p>
        )}
        {!!recorders.data?.length && (
          <table className="table">
            <thead><tr><th>Key</th><th>Last data</th></tr></thead>
            <tbody>
              {recorders.data.map((r) => (
                <tr key={r.key}>
                  <td><Link to={`/projects/${projectId}/recorders/${encodeURIComponent(r.key)}/live`}><code>{r.key}</code></Link></td>
                  <td>{ago(r.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {manageKeys && (
        <section className="panel-section">
          <h3>Ingest keys</h3>
          <IngestKeys key={keysVersion} projectId={projectId} onError={setError} />
        </section>
      )}

      {administer && <ProjectAccess projectId={projectId} orgId={project.data.orgId} />}

      {administer && (
        <section className="panel-section danger">
          <h3>Delete project</h3>
          <p className="muted">Deletes every recorder and recording in it, and its keys stop working.</p>
          <button onClick={() => window.confirm(`Delete ${project.data!.name} and all of its recordings? This can't be undone.`) && act(async () => { await api.deleteProject(projectId); navigate(`/orgs/${project.data!.orgId}`); })}>Delete project</button>
        </section>
      )}
      {manageKeys && connect && <ConnectDialog projectId={projectId} startAt={connect} onClose={() => setConnect(null)} onKeyCreated={() => setKeysVersion((v) => v + 1)} />}
    </div>
  );
}
