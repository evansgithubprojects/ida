import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api } from '../cloud/api';
import { useSession } from '../cloud/auth';
import { supabase } from '../cloud/supabase';
import { useApi } from '../cloud/useApi';
import { NarrowSkeleton } from '../components/Skeleton';

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
  const { data: invite, error } = useApi(`invite:${token}`, () => api.lookupInvite(token));
  const [failure, setFailure] = useState<string | null>(null);
  if (error) return <div className="page narrow"><h2>Invitation not found</h2><p className="muted">This link is not valid. Check that you copied all of it, or ask for a new invitation.</p><Link to="/projects">Go to your projects</Link></div>;
  if (!invite) return <NarrowSkeleton />;
  const as = invite.orgRole === 'admin' ? 'an admin' : 'a member';
  return (
    <div className="page narrow">
      <h2>Join {invite.orgName}</h2>
      <p>
        {invite.invitedBy ?? 'Someone'} invited {invite.forYou ? 'you' : 'someone'} to join <strong>{invite.orgName}</strong> as {as}.
      </p>
      {invite.state !== 'open' && (invite.orgId
        ? <p>You are already a member of {invite.orgName}. <Link to={`/orgs/${invite.orgId}`}>Go to {invite.orgName}</Link></p>
        : <p className="form-error" role="alert">{WHY[invite.state]}</p>)}
      {invite.state === 'open' && !invite.forYou && (
        <>
          <p className="form-error" role="alert">
            This invitation was sent to a different email address{session?.user.email ? <> than the one you are signed in with ({session.user.email})</> : null}.
            Sign out and sign in with the address it was sent to.
          </p>
          {/* Signing out lands on sign-in, which returns here afterwards. */}
          <button onClick={() => void supabase?.auth.signOut()}>Sign out</button>
        </>
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
