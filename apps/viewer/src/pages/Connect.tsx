import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api } from '../cloud/api';
import { useApi } from '../cloud/useApi';
import { IngestKeys } from '../components/IngestKeys';
import { SetupSnippet } from '../components/SetupSnippet';

/** First-run walkthrough after a project is created: make a key, add the setup, wait for the first data. */
export function Connect() {
  const { projectId = '' } = useParams();
  const project = useApi(() => api.project(projectId), [projectId]);
  const keys = useApi(() => api.keys(projectId), [projectId], 5_000);
  const recorders = useApi(() => api.recorders(projectId), [projectId], 3_000);
  const [error, setError] = useState<string | null>(null);

  if (project.error) return <div className="page"><p className="form-error" role="alert">{project.error}</p><Link to="/projects">All projects</Link></div>;
  if (!project.data) return <div className="page"><p className="muted">Loading…</p></div>;

  const hasKey = !!keys.data?.some((k) => !k.revokedAt);
  const recorder = recorders.data?.[0];
  const base = `/projects/${projectId}`;

  return (
    <div className="page">
      <nav className="crumbs"><Link to="/projects">Projects</Link><span>›</span><span>{project.data.name}</span></nav>
      <div className="page-head">
        <h2>Connect your app to {project.data.name}</h2>
        <Link to={base}>{recorder ? 'Go to project' : 'Skip for now'}</Link>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}

      <section className="panel-section">
        <h3>1. Create an ingest key {hasKey && <span className="step-done">✓</span>}</h3>
        <IngestKeys projectId={projectId} onError={setError} />
      </section>

      <section className="panel-section">
        <h3>2. Add it to your app</h3>
        <SetupSnippet />
      </section>

      <section className="panel-section">
        <h3>3. Run your app {recorder && <span className="step-done">✓</span>}</h3>
        {recorder ? (
          <>
            <p>Connected: <code>{recorder.key}</code> is sending events.</p>
            <Link className="button primary" to={`${base}/recorders/${encodeURIComponent(recorder.key)}/live`}>Open the viewer</Link>{' '}
            <Link className="button" to={base}>Go to project</Link>
          </>
        ) : (
          <p className="muted">Waiting for the first events… this page updates by itself once your app sends data.</p>
        )}
      </section>
    </div>
  );
}
