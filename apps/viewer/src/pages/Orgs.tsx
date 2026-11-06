import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, useNavigate } from 'react-router';
import { api, type OrgRole } from '../cloud/api';
import { ago, useApi } from '../cloud/useApi';
import { can, orgToOpen, useMe, useOrg } from '../cloud/orgs';
import { useSession } from '../cloud/auth';

/** `/projects`: sends the user to the org they were last in. */
export function ProjectsRedirect() {
  const { me, error } = useMe();
  if (error) return <div className="page"><p className="form-error" role="alert">{error}</p></div>;
  if (!me) return <div className="page"><p className="muted">Loading…</p></div>;
  const org = orgToOpen(me.orgs);
  return org ? <Navigate to={`/orgs/${org.id}`} replace /> : <div className="page"><p className="muted">You don't belong to an organization yet.</p></div>;
}

export function NewOrg() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  return (
    <div className="page narrow">
      <h2>New organization</h2>
      <p className="muted">An organization holds projects and the people who can see them. You will be its owner.</p>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        try { navigate(`/orgs/${(await api.createOrg(name)).id}`); } catch (err) { setError((err as Error).message); }
      }}>
        <input placeholder="Organization name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} aria-label="Organization name" autoFocus />
        <button className="primary">Create organization</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

/** The org's name, who the user is in it, and tabs for its pages. */
function OrgHeader({ name, role, personal }: { name: string; role: OrgRole; personal: boolean }) {
  return (
    <>
      <div className="page-head">
        <h2>{name}</h2>
        <span className="muted">{personal ? 'Personal · ' : ''}you are {role === 'admin' ? 'an' : 'a'} {role}</span>
      </div>
      <nav className="org-tabs" aria-label="Organization">
        <NavLink to="." end>Projects</NavLink>
        <NavLink to="members">Members</NavLink>
        <NavLink to="settings">Settings</NavLink>
      </nav>
    </>
  );
}

function OrgPage({ children }: { children: (org: NonNullable<ReturnType<typeof useOrg>['org']>, reload: () => void) => React.ReactNode }) {
  const { org, error, reload } = useOrg();
  if (error) return <div className="page"><p className="form-error" role="alert">{error}</p><Link to="/projects">Back</Link></div>;
  if (!org) return <div className="page"><p className="muted">Loading…</p></div>;
  return <div className="page"><OrgHeader name={org.name} role={org.role} personal={org.personal} />{children(org, reload)}</div>;
}

export function OrgProjects() {
  return (
    <OrgPage>
      {(org) => <ProjectList orgId={org.id} canCreate={can.createProjects(org.role)} />}
    </OrgPage>
  );
}

function ProjectList({ orgId, canCreate }: { orgId: string; canCreate: boolean }) {
  const { data: projects, error } = useApi(() => api.orgProjects(orgId), [orgId]);
  const [name, setName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const navigate = useNavigate();
  return (
    <>
      {error && <p className="form-error" role="alert">{error}</p>}
      {projects && projects.length === 0 && (
        <p className="muted">{canCreate ? 'No projects yet. Create one to get a key for your app.' : 'You have not been given access to any projects here yet. Ask an owner or admin.'}</p>
      )}
      {projects && projects.length > 0 && (
        <ul className="cards">
          {projects.map((p) => (
            <li key={p.id}>
              <Link className="card" to={`/projects/${p.id}`}>
                <strong>{p.name}</strong>
                <span className="muted">{p.recorders} recorder{p.recorders === 1 ? '' : 's'} · {ago(p.lastSeenAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canCreate && (
        <form className="form inline" onSubmit={async (e) => {
          e.preventDefault();
          try { navigate(`/projects/${(await api.createOrgProject(orgId, name)).id}`, { state: { connect: true } }); } catch (err) { setCreateError((err as Error).message); }
        }}>
          <input placeholder="New project name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} aria-label="New project name" />
          <button className="primary">Create project</button>
        </form>
      )}
      {createError && <p className="form-error" role="alert">{createError}</p>}
    </>
  );
}

export function OrgMembers() {
  return <OrgPage>{(org) => <MemberList orgId={org.id} myRole={org.role} />}</OrgPage>;
}

const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function MemberList({ orgId, myRole }: { orgId: string; myRole: OrgRole }) {
  const { data: members, error, reload } = useApi(() => api.members(orgId), [orgId]);
  const session = useSession();
  const me = session?.user.id;
  const [failure, setFailure] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setFailure(null);
    try { await fn(); reload(); } catch (err) { setFailure((err as Error).message); }
  };
  return (
    <section className="panel-section">
      <h3>Members</h3>
      {(error || failure) && <p className="form-error" role="alert">{error ?? failure}</p>}
      {members && (
        <table className="table">
          <thead><tr><th>Person</th><th>Role</th><th /></tr></thead>
          <tbody>
            {members.map((m) => {
              // Admins manage members and other admins; owners are only touched by owners.
              const editable = can.manageMembers(myRole) && (m.role !== 'owner' || can.touchOwner(myRole));
              const roles = (can.touchOwner(myRole) ? ['owner', 'admin', 'member'] : ['admin', 'member']) as OrgRole[];
              return (
                <tr key={m.userId}>
                  <td>{m.name ?? m.email ?? m.userId}{m.name && m.email && <span className="muted"> · {m.email}</span>}{m.userId === me && <span className="muted"> (you)</span>}</td>
                  <td>
                    {editable ? (
                      <select aria-label={`Role of ${m.name ?? m.email ?? m.userId}`} value={m.role} onChange={(e) => void act(() => api.setMemberRole(orgId, m.userId, e.target.value as OrgRole))}>
                        {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    ) : ROLE_LABEL[m.role]}
                  </td>
                  <td>
                    {m.userId === me
                      ? <button onClick={() => window.confirm('Leave this organization? You will lose access to its projects.') && void act(() => api.removeMember(orgId, m.userId))}>Leave</button>
                      : editable && <button onClick={() => window.confirm(`Remove ${m.name ?? m.email ?? m.userId} from this organization?`) && void act(() => api.removeMember(orgId, m.userId))}>Remove</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function OrgSettings() {
  return <OrgPage>{(org, reload) => <Settings org={org} reload={reload} />}</OrgPage>;
}

function Settings({ org, reload }: { org: NonNullable<ReturnType<typeof useOrg>['org']>; reload: () => void }) {
  const [name, setName] = useState(org.name);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { reload: reloadMe } = useMe();
  useEffect(() => setName(org.name), [org.name]);
  const owner = can.editOrg(org.role);
  return (
    <>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="panel-section">
        <h3>Name</h3>
        <form className="form inline" onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try { await api.renameOrg(org.id, name); reload(); } catch (err) { setError((err as Error).message); }
        }}>
          <input value={name} required maxLength={100} disabled={!owner} onChange={(e) => setName(e.target.value)} aria-label="Organization name" />
          {owner && <button className="primary" disabled={name.trim() === org.name}>Rename</button>}
        </form>
        {!owner && <p className="muted">Only an owner can rename the organization.</p>}
      </section>
      {owner && !org.personal && (
        <section className="panel-section danger">
          <h3>Delete organization</h3>
          <p className="muted">Deletes every project and recording in it. This can't be undone.</p>
          <button onClick={() => window.confirm(`Delete ${org.name} and everything in it? This can't be undone.`) && void (async () => {
            try { await api.deleteOrg(org.id); reloadMe(); navigate('/projects'); } catch (err) { setError((err as Error).message); }
          })()}>Delete organization</button>
        </section>
      )}
    </>
  );
}
