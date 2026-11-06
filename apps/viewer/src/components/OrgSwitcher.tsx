import { useLocation, useNavigate, useParams } from 'react-router';
import { api } from '../cloud/api';
import { orgToOpen } from '../cloud/orgs';
import { useApi } from '../cloud/useApi';

const NEW = '__new__';

/** Header control for moving between the organizations the user belongs to. */
export function OrgSwitcher() {
  const { orgId } = useParams();
  const navigate = useNavigate();
  // Refetched on every navigation, so a new, renamed or deleted org shows up as soon as the user lands on a page.
  const { key } = useLocation();
  const { data: me } = useApi(api.me, [key]);
  if (!me || me.orgs.length === 0) return null;
  const current = me.orgs.find((o) => o.id === orgId) ?? orgToOpen(me.orgs);
  return (
    <select
      className="org-select"
      aria-label="Organization"
      value={current?.id}
      onChange={(e) => navigate(e.target.value === NEW ? '/orgs/new' : `/orgs/${e.target.value}`)}
    >
      {me.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      <option value={NEW}>New organization…</option>
    </select>
  );
}
