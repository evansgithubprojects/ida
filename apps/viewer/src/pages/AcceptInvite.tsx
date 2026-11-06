import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../cloud/api';
import { useSession } from '../cloud/auth';
import { useApi } from '../cloud/useApi';

const WHY: Record<string, string> = {
  accepted: 'This invitation was already used.',
  revoked: 'This invitation was cancelled.',
  expired: 'This invitation has expired. Ask the person who invited you to send a new one.',
};

/** `/invites/:token`: what the emailed link opens. Shows who invited you to what, and accepts it on a click. */
export function AcceptInvite() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const session = useSession();
  const { data: invite, error } = useApi(() => api.lookupInvite(token), [token]);
  const [failure, setFailure] = useState<string | null>(null);
  if (error) return <div className="page narrow"><h2>Invitation not found</h2><p className="muted">This link is not valid. Check that you copied all of it, or ask for a new invitation.</p><Link to="/projects">Go to your projects</Link></div>;
  if (!invite) return <div className="page narrow"><p className="muted">Loading…</p></div>;
  const as = invite.orgRole === 'admin' ? 'an admin' : 'a member';
  return (
    <div className="page narrow">
      <h2>Join {invite.orgName}</h2>
      <p>{invite.invitedBy ?? 'Someone'} invited you to join <strong>{invite.orgName}</strong> as {as}.</p>
      {invite.state !== 'open' && <p className="form-error" role="alert">{WHY[invite.state]}</p>}
      {invite.state === 'open' && !invite.forYou && (
        <p className="form-error" role="alert">
          This invitation was sent to a different email address{session?.user.email ? <> than the one you are signed in with ({session.user.email})</> : null}.
          Sign out and sign in with the address it was sent to.
        </p>
      )}
      {invite.state === 'open' && invite.forYou && (
        <button className="primary" onClick={async () => {
          setFailure(null);
          try { navigate(`/orgs/${(await api.acceptInvite({ token })).orgId}`); } catch (err) { setFailure((err as Error).message); }
        }}>Accept invitation</button>
      )}
      {failure && <p className="form-error" role="alert">{failure}</p>}
    </div>
  );
}
