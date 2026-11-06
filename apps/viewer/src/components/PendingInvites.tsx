import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api } from '../cloud/api';
import { useApi } from '../cloud/useApi';

/** A strip under the header for invitations waiting for the signed-in person, each with an Accept button. */
export function PendingInvites() {
  // Refetched as the user moves around, so a new invitation shows up without a reload.
  const { key } = useLocation();
  const { data: invites, reload } = useApi(api.pendingInvites, [key]);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  if (!invites?.length) return null;
  return (
    <div className="invite-banner" role="status">
      {invites.map((i) => (
        <div key={i.id} className="invite-banner-row">
          <span><strong>{i.invitedBy ?? 'Someone'}</strong> invited you to join <strong>{i.orgName}</strong> as {i.orgRole === 'admin' ? 'an admin' : 'a member'}.</span>
          <button className="primary" onClick={async () => {
            setError(null);
            try { const { orgId } = await api.acceptInvite({ id: i.id }); reload(); navigate(`/orgs/${orgId}`); } catch (err) { setError((err as Error).message); }
          }}>Accept</button>
        </div>
      ))}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
