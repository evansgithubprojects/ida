import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../cloud/api';
import { API_URL } from '../cloud/supabase';
import { ago, useApi } from '../cloud/useApi';

export function Project() {
  const { projectId = '' } = useParams();
  const navigate = useNavigate();
  const project = useApi(() => api.project(projectId), [projectId]);
  const recorders = useApi(() => api.recorders(projectId), [projectId], 10_000);
  const keys = useApi(() => api.keys(projectId), [projectId]);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (project.error) return <div className="page"><p className="form-error" role="alert">{project.error}</p><Link to="/projects">All projects</Link></div>;
  if (!project.data) return <div className="page"><p className="muted">Loading…</p></div>;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError((err as Error).message); }
  };
  const active = keys.data?.filter((k) => !k.revokedAt) ?? [];

  return (
    <div className="page">
      <nav className="crumbs"><Link to="/projects">Projects</Link><span>›</span><span>{project.data.name}</span></nav>
      <h2>{project.data.name}</h2>
      {error && <p className="form-error" role="alert">{error}</p>}

      <section className="panel-section">
        <h3>Recorders</h3>
        {recorders.data?.length === 0 && <p className="muted">Nothing has been uploaded yet. Add the setup below to your app; recorders show up here once they send data.</p>}
        {!!recorders.data?.length && (
          <table className="table">
            <thead><tr><th>Key</th><th>Sessions</th><th>Last data</th><th /></tr></thead>
            <tbody>
              {recorders.data.map((r) => (
                <tr key={r.key}>
                  <td><Link to={`/projects/${projectId}/recorders/${encodeURIComponent(r.key)}`}><code>{r.key}</code></Link></td>
                  <td>{r.sessions}</td>
                  <td>{ago(r.lastSeenAt)}</td>
                  <td>{r.live && <Link className="live live-on" to={`/projects/${projectId}/recorders/${encodeURIComponent(r.key)}/live`}>● live</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel-section">
        <h3>Setup</h3>
        <pre className="snippet">{`npm install @eda-debugger/core @eda-debugger/cloud @eda-debugger/adapter-eventemitter

import { configure } from '@eda-debugger/cloud';
import { connectRecorder } from '@eda-debugger/core';
import { enableEventEmitterRecording } from '@eda-debugger/adapter-eventemitter';

configure({ projectKey: process.env.EDA_PROJECT_KEY, endpoint: '${API_URL}' });
enableEventEmitterRecording();

// anywhere in your app
connectRecorder('payments').track(paymentsBus);`}</pre>
      </section>

      <section className="panel-section">
        <h3>Ingest keys</h3>
        <p className="muted">Keys can only upload data. Revoke one if it leaks; apps using it stop uploading.</p>
        {fresh && (
          <div className="notice" role="status">
            <p>Copy this key now. It won't be shown again.</p>
            <code className="secret">{fresh}</code>
            <button onClick={() => void navigator.clipboard?.writeText(fresh)}>Copy</button>
            <button onClick={() => setFresh(null)}>Done</button>
          </div>
        )}
        {active.length > 0 && (
          <table className="table">
            <thead><tr><th>Key</th><th>Label</th><th>Created</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {active.map((k) => (
                <tr key={k.id}>
                  <td><code>{k.prefix}…</code></td>
                  <td>{k.label || <span className="muted">—</span>}</td>
                  <td>{ago(k.createdAt)}</td>
                  <td>{ago(k.lastUsedAt)}</td>
                  <td>
                    <button onClick={() => window.confirm(`Revoke ${k.prefix}…? Apps using it stop uploading.`) && act(async () => { await api.revokeKey(projectId, k.id); keys.reload(); })}>Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form className="form inline" onSubmit={(e) => { e.preventDefault(); void act(async () => { const k = await api.createKey(projectId, label); setFresh(k.key); setLabel(''); keys.reload(); }); }}>
          <input placeholder="Label (optional), e.g. staging" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Key label" />
          <button className="primary">New key</button>
        </form>
      </section>

      <section className="panel-section danger">
        <h3>Delete project</h3>
        <p className="muted">Deletes every recorder and recording in it, and its keys stop working.</p>
        <button onClick={() => window.confirm(`Delete ${project.data!.name} and all of its recordings? This can't be undone.`) && act(async () => { await api.deleteProject(projectId); navigate('/projects'); })}>Delete project</button>
      </section>
    </div>
  );
}
