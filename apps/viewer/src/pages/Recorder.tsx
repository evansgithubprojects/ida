import { Link, useParams } from 'react-router';
import { api } from '../cloud/api';
import { ago, useApi } from '../cloud/useApi';
import { Bone, TableSkeleton } from '../components/Skeleton';

export function Recorder() {
  const { projectId = '', recorderKey = '' } = useParams();
  const project = useApi(`project:${projectId}`, () => api.project(projectId));
  const sessions = useApi(`sessions:${projectId}:${recorderKey}`, () => api.sessions(projectId, recorderKey), { pollMs: 10_000 });
  const base = `/projects/${projectId}/recorders/${encodeURIComponent(recorderKey)}`;

  return (
    <div className="page">
      <nav className="crumbs">
        <Link to={project.data ? `/orgs/${project.data.orgId}` : "/projects"}>Projects</Link><span>›</span>
        <Link to={`/projects/${projectId}`}>{project.data?.name ?? <Bone w="6em" />}</Link><span>›</span>
        <code>{recorderKey}</code>
      </nav>
      <div className="page-head">
        <h2><code>{recorderKey}</code></h2>
        <Link className="button primary" to={`${base}/live`}>● Watch live</Link>
      </div>
      {sessions.error && <p className="form-error" role="alert">{sessions.error}</p>}
      <h3>Recordings</h3>
      <p className="muted">Each run of your app is one recording.</p>
      {!sessions.data && !sessions.error && <TableSkeleton heads={['Started', 'Events', 'Runtime', 'Last data', '']} />}
      {sessions.data?.length === 0 && <p className="muted">No recordings yet.</p>}
      {!!sessions.data?.length && (
        <table className="table">
          <thead><tr><th>Started</th><th>Events</th><th>Runtime</th><th>Last data</th><th /></tr></thead>
          <tbody>
            {sessions.data.map((s) => (
              <tr key={s.id}>
                <td><Link to={`${base}/sessions/${s.id}`}>{new Date(s.startedAt).toLocaleString()}</Link></td>
                <td>
                  {s.occurrences}
                  {s.gaps > 0 && <span className="badge badge-warn" title="Some events were dropped because the offline spool was full">gaps</span>}
                </td>
                <td className="muted">{s.runtime || '—'}</td>
                <td>{ago(s.lastSeenAt)}</td>
                <td>{s.live && <span className="live live-on">● live</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
