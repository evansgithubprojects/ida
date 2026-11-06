import { useEffect, useState, ViewTransition } from 'react';
import { Link, Navigate, NavLink, Outlet, useNavigate, useOutletContext } from 'react-router';
import { api, type InviteSent, type Org, type OrgRole, type ProjectRole } from '../cloud/api';
import { ago, useApi } from '../cloud/useApi';
import { can, orgToOpen, useMe, useOrg } from '../cloud/orgs';
import { useSession } from '../cloud/auth';

/**
 * `/projects`: sends the user to the org they were last in. Someone in no org yet (invited people who haven't accepted,
 * or people who left every org) is asked to create one; pending invitations show in the banner above.
 */
export function ProjectsRedirect() {
  const { me, error } = useMe();
  if (error) return <div className="page"><p className="form-error" role="alert">{error}</p></div>;
  if (!me) return <div className="page"><p className="muted">Loading…</p></div>;
  const org = orgToOpen(me.orgs);
  if (org) return <Navigate to={`/orgs/${org.id}`} replace />;
  return (
    <div className="page narrow">
      <h2>Set up your organization</h2>
      <p className="muted">
        Projects live in an organization, together with the people who can see them. Create one for your team, or accept
        an invitation above if someone has invited you to theirs.
      </p>
      <CreateOrgForm />
    </div>
  );
}

export function NewOrg() {
  return (
    <div className="page narrow">
      <h2>New organization</h2>
      <p className="muted">An organization holds projects and the people who can see them. You will be its owner.</p>
      <CreateOrgForm />
    </div>
  );
}

/** Names a new org, makes the user its owner, and opens it. */
function CreateOrgForm() {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  return (
    <>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        try { navigate(`/orgs/${(await api.createOrg(name)).id}`); } catch (err) { setError((err as Error).message); }
      }}>
        <input placeholder="Organization name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} aria-label="Organization name" autoFocus />
        <button className="primary">Create organization</button>
      </form>
      {error && <p className="form-error" role="alert">{error}</p>}
    </>
  );
}

/** The org's name, who the user is in it, and tabs for its pages. */
function OrgHeader({ id, name, role }: { id: string; name: string; role: OrgRole }) {
  const base = `/orgs/${id}`;
  return (
    <>
      <div className="page-head">
        <h2>{name}</h2>
        <span className="muted">You are {role === 'member' ? 'a' : 'an'} {role}</span>
      </div>
      <nav className="org-tabs" aria-label="Organization">
        <NavLink to={base} end>Projects</NavLink>
        <NavLink to={`${base}/members`}>Members</NavLink>
        <NavLink to={`${base}/settings`}>Settings</NavLink>
        <NavLink to={`${base}/profile`}>Org Profile</NavLink>
      </nav>
    </>
  );
}

interface OrgContext { org: Org; reload: () => void }
const useOrgContext = () => useOutletContext<OrgContext>();

/**
 * Parent route of the org's tabs. It loads the org once, so the title and tabs stay put while switching between
 * tabs; only the tab's own content (the `Outlet`) changes.
 */
export function OrgLayout() {
  const { org, error, reload } = useOrg();
  if (error) return <div className="page"><p className="form-error" role="alert">{error}</p><Link to="/projects">Back</Link></div>;
  if (!org) return <div className="page"><p className="muted">Loading…</p></div>;
  return (
    <div className="page">
      <OrgHeader id={org.id} name={org.name} role={org.role} />
      {/* Its own boundary, so switching tabs doesn't trigger the shell's page wipe: only the tab's content changes. */}
      <ViewTransition update="none"><Outlet context={{ org, reload } satisfies OrgContext} /></ViewTransition>
    </div>
  );
}

export function OrgProjects() {
  const { org } = useOrgContext();
  return <ProjectList orgId={org.id} canCreate={can.createProjects(org.role)} />;
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
  const { org } = useOrgContext();
  return (
    <>
      <MemberList orgId={org.id} myRole={org.role} />
      {can.manageMembers(org.role) && <Invites orgId={org.id} />}
    </>
  );
}

const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** The signed-in user's own place in this org: their role, and the name the others here see. */
export function OrgProfile() {
  const { org } = useOrgContext();
  const { data: profile, error, reload } = useApi(() => api.orgProfile(org.id), [org.id]);
  const [name, setName] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (profile) setName(profile.displayName); }, [profile]);
  const unchanged = name.trim() === profile?.displayName;
  return (
    <section className="panel-section">
      <h3>Your profile in {org.name}</h3>
      {(error || failure) && <p className="form-error" role="alert">{error ?? failure}</p>}
      {profile && (
        <>
          <form className="form" onSubmit={async (e) => {
            e.preventDefault();
            setFailure(null);
            setSaved(false);
            try { await api.setOrgProfile(org.id, name.trim()); reload(); setSaved(true); } catch (err) { setFailure((err as Error).message); }
          }}>
            <label>
              Display name
              <input value={name} maxLength={100} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
            </label>
            <p className="hint">
              Shown to the other people in this organization.
            </p>
            <div className="page-actions">
              <button className="primary" disabled={unchanged}>Save</button>
              {saved && <span className="muted" role="status">Saved</span>}
            </div>
          </form>
          <dl className="facts">
            <dt>Role</dt>
            <dd>{ROLE_LABEL[profile.role]}</dd>
            {profile.email && <><dt>Email</dt><dd>{profile.email}</dd></>}
            <dt>Joined</dt>
            <dd>{new Date(profile.joinedAt).toLocaleDateString()}</dd>
          </dl>
        </>
      )}
    </section>
  );
}

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
              // The only owner can't step down or leave: the org always needs one.
              const lastOwner = m.role === 'owner' && members.filter((x) => x.role === 'owner').length === 1;
              // Admins manage members and other admins; owners are only touched by owners.
              const editable = !lastOwner && can.manageMembers(myRole) && (m.role !== 'owner' || can.touchOwner(myRole));
              const roles = (can.touchOwner(myRole) ? ['owner', 'admin', 'member'] : ['admin', 'member']) as OrgRole[];
              return (
                <tr key={m.userId}>
                  <td>{m.name ?? m.email ?? m.userId}{m.name && m.email && m.name !== m.email && <span className="muted"> · {m.email}</span>}{m.userId === me && <span className="muted"> (you)</span>}</td>
                  <td>
                    {editable ? (
                      <select aria-label={`Role of ${m.name ?? m.email ?? m.userId}`} value={m.role} onChange={(e) => void act(() => api.setMemberRole(orgId, m.userId, e.target.value as OrgRole))}>
                        {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    ) : ROLE_LABEL[m.role]}
                  </td>
                  <td>
                    {/* "Only owner" explains a missing Leave or Remove, so only show it to someone who could otherwise act. */}
                    {lastOwner
                      ? (m.userId === me || can.manageMembers(myRole)) && <span className="muted" title="Make someone else an owner first">Only owner</span>
                      : m.userId === me
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

/** Tells an admin what happened to an invitation: emailed, or here is the link to share by hand. */
function SentNotice({ sent }: { sent: InviteSent }) {
  if (sent.emailed) return <p className="notice" role="status">Invitation emailed to {sent.email}.</p>;
  return (
    <div className="notice" role="status">
      <p>{sent.mailError ? 'The email could not be sent.' : 'Email is not set up on this server.'} Share this link with {sent.email} yourself. It works for 7 days and only with that address.</p>
      <div className="form inline">
        <input readOnly value={sent.link ?? ''} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" onClick={() => void navigator.clipboard?.writeText(sent.link ?? '')}>Copy link</button>
      </div>
    </div>
  );
}

function Invites({ orgId }: { orgId: string }) {
  const { data: invites, error, reload } = useApi(() => api.invites(orgId), [orgId]);
  const { data: projects } = useApi(() => api.orgProjects(orgId), [orgId]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [grants, setGrants] = useState<Record<string, ProjectRole | ''>>({});
  const [sent, setSent] = useState<InviteSent | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<InviteSent | void>) => {
    setFailure(null);
    try { const r = await fn(); setSent(r ?? null); reload(); } catch (err) { setFailure((err as Error).message); }
  };
  const nameOf = (id: string) => projects?.find((p) => p.id === id)?.name ?? 'a deleted project';
  return (
    <section className="panel-section">
      <h3>Invite people</h3>
      {(error || failure) && <p className="form-error" role="alert">{error ?? failure}</p>}
      <form className="form" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        await act(async () => {
          const chosen = role === 'member' ? Object.entries(grants).filter(([, r]) => r).map(([projectId, r]) => ({ projectId, role: r as ProjectRole })) : [];
          const result = await api.createInvite(orgId, email, role, chosen);
          setEmail('');
          setGrants({});
          return result;
        });
        setBusy(false);
      }}>
        <div className="form inline">
          <input type="email" required placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email address" />
          <label>
            Role
            <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
              <option value="member">Member</option>
              <option value="admin">Admin (sees every project)</option>
            </select>
          </label>
        </div>
        {role === 'member' && !!projects?.length && (
          <fieldset className="grants">
            <legend>Access scope</legend>
            {projects.map((p) => (
              <label key={p.id} className="grant">
                <span>{p.name}</span>
                <select value={grants[p.id] ?? ''} onChange={(e) => setGrants({ ...grants, [p.id]: e.target.value as ProjectRole | '' })} aria-label={`Access to ${p.name}`}>
                  <option value="">No access</option>
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
              </label>
            ))}
          </fieldset>
        )}
        <div><button className="primary" disabled={busy}>Send invitation</button></div>
      </form>
      {sent && <SentNotice sent={sent} />}
      {!!invites?.length && (
        <>
          <h3 className="sub">Waiting to be accepted</h3>
          <table className="table">
            <thead><tr><th>Email</th><th>Role</th><th>Projects</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {invites.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}</td>
                  <td>{i.orgRole === 'admin' ? 'Admin' : 'Member'}</td>
                  <td>{i.orgRole === 'admin' ? 'All' : i.projects.length ? i.projects.map((g) => `${nameOf(g.projectId)} (${g.role})`).join(', ') : 'None yet'}</td>
                  <td>{i.expired ? <span className="form-error">Expired</span> : new Date(i.expiresAt).toLocaleDateString()}</td>
                  <td className="row-actions">
                    <button onClick={() => void act(() => api.resendInvite(orgId, i.id))}>Resend</button>
                    <button onClick={() => void act(async () => { await api.revokeInvite(orgId, i.id); })}>Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

export function OrgSettings() {
  const { org, reload } = useOrgContext();
  return <Settings org={org} reload={reload} />;
}

function Settings({ org, reload }: OrgContext) {
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
        {owner ? (
          <form className="form inline" onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try { await api.renameOrg(org.id, name); reload(); } catch (err) { setError((err as Error).message); }
          }}>
            <input value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} aria-label="Organization name" />
            <button className="primary" disabled={name.trim() === org.name}>Rename</button>
          </form>
        ) : (
          <>
            {/* Shown as text: a greyed-out field reads as editable. */}
            <p>{org.name}</p>
          </>
        )}
      </section>
      {owner && (
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
