import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api } from '../cloud/api';
import { ago, useApi } from '../cloud/useApi';

export function Projects() {
  const { data: projects, error } = useApi(api.projects, []);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const navigate = useNavigate();

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const p = await api.createProject(name);
      navigate(`/projects/${p.id}/connect`);
    } catch (err) {
      setCreateError((err as Error).message);
    }
  };

  return (
    <div className="page">
      <h2>Projects</h2>
      {error && <p className="form-error" role="alert">{error}</p>}
      {projects && projects.length === 0 && <p className="muted">No projects yet. Create one to get a key for your app.</p>}
      {projects && projects.length > 0 && (
        <ul className="cards">
          {projects.map((p) => (
            <li key={p.id}>
              <Link className="card" to={`/projects/${p.id}`}>
                <strong>{p.name}</strong>
                <span className="muted">{p.recorders ?? 0} recorder{p.recorders === 1 ? '' : 's'} · last data {ago(p.lastSeenAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <form className="form inline" onSubmit={create}>
        <input placeholder="New project name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} aria-label="New project name" />
        <button className="primary">Create project</button>
      </form>
      {createError && <p className="form-error" role="alert">{createError}</p>}
    </div>
  );
}
