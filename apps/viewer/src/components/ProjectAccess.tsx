import { useState } from 'react';
import { Link } from 'react-router';
import { api, type ProjectRole } from '../cloud/api';
import { useApi } from '../cloud/useApi';

const ORG_ROLE: Record<string, string> = { owner: 'Owner', admin: 'Admin' };

/** Who can open a project, for owners and admins: the org's owners and admins always can; members only when granted. */
export function ProjectAccess({ projectId, orgId }: { projectId: string; orgId: string }) {
  const { data: people, error, reload } = useApi(() => api.projectMembers(projectId), [projectId]);
  const { data: orgMembers } = useApi(() => api.members(orgId), [orgId]);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<ProjectRole>('viewer');
  const [failure, setFailure] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setFailure(null);
    try { await fn(); reload(); } catch (err) { setFailure((err as Error).message); }
  };
  const name = (m: { name: string | null; email: string | null; userId: string }) => m.name ?? m.email ?? m.userId;
  const hasAccess = new Set(people?.map((p) => p.userId));
  // Owners and admins already see everything, so only plain members can be added.
  const candidates = orgMembers?.filter((m) => m.role === 'member' && !hasAccess.has(m.userId)) ?? [];
  return (
    <section className="panel-section">
      <h3>Access</h3>
      <p className="muted">Owners and admins of the organization can open every project. Members can open only the projects they are added to here.</p>
      {(error || failure) && <p className="form-error" role="alert">{error ?? failure}</p>}
      {people && (
        <table className="table">
          <thead><tr><th>Person</th><th>Access</th><th /></tr></thead>
          <tbody>
            {people.map((m) => (
              <tr key={m.userId}>
                <td>{name(m)}{m.name && m.email && <span className="muted"> · {m.email}</span>}</td>
                <td>
                  {m.via === 'org'
                    ? <span className="muted">{ORG_ROLE[m.orgRole] ?? m.orgRole} of the organization</span>
                    : (
                      <select value={m.access} aria-label={`Access of ${name(m)}`} onChange={(e) => void act(() => api.setProjectAccess(projectId, m.userId, e.target.value as ProjectRole))}>
                        <option value="viewer">Viewer</option>
                        <option value="editor">Editor</option>
                      </select>
                    )}
                </td>
                <td>{m.via === 'project' && <button onClick={() => void act(() => api.removeProjectAccess(projectId, m.userId))}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {candidates.length > 0 ? (
        <form className="form inline" onSubmit={(e) => { e.preventDefault(); if (pick) void act(async () => { await api.setProjectAccess(projectId, pick, role); setPick(''); }); }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Person to add">
            <option value="">Add a member…</option>
            {candidates.map((m) => <option key={m.userId} value={m.userId}>{name(m)}</option>)}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)} aria-label="Access to give">
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
          <button className="primary" disabled={!pick}>Add</button>
        </form>
      ) : (
        <p className="muted">Every member of the organization already has access. <Link to={`/orgs/${orgId}/members`}>Invite someone</Link> to add more.</p>
      )}
      <p className="muted">Viewers can look at recordings. Editors can also manage ingest keys and connect an app.</p>
    </section>
  );
}
