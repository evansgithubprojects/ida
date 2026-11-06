import { useEffect } from 'react';
import { useParams } from 'react-router';
import { api, type Me, type Org, type OrgRole, type ProjectAccessLevel } from './api';
import { useApi } from './useApi';

const KEY = 'ida_last_org';

/** Remembers the org last opened in this browser, so "Projects" goes back to it. */
export function rememberOrg(orgId: string): void {
  try { localStorage.setItem(KEY, orgId); } catch { /* storage unavailable: falls back to the first org */ }
}

/** The org to open when none is named: the last one opened if the user still belongs to it, else the first. */
export function orgToOpen(orgs: readonly Org[]): Org | null {
  let last: string | null = null;
  try { last = localStorage.getItem(KEY); } catch { /* ignore */ }
  return orgs.find((o) => o.id === last) ?? orgs[0] ?? null;
}

/** What each org role may do. The server enforces all of it; this only decides what to show. */
export const can = {
  createProjects: (role: OrgRole) => role === 'owner' || role === 'admin',
  manageMembers: (role: OrgRole) => role === 'owner' || role === 'admin',
  editOrg: (role: OrgRole) => role === 'owner',
  /** Only owners hand out or take away ownership. */
  touchOwner: (role: OrgRole) => role === 'owner',
};

/** What each level of access to a project may do. Again the server enforces it; this only decides what to show. */
export const canInProject = {
  /** Ingest keys and connecting an app. */
  manageKeys: (a: ProjectAccessLevel) => a === 'editor' || a === 'admin',
  /** Deleting the project and choosing who can open it. */
  administer: (a: ProjectAccessLevel) => a === 'admin',
};

/**
 * The signed-in user and their orgs. `reload` after creating, renaming, leaving or deleting an org. `fresh` is false
 * while only a cached copy is known: check it before redirecting, since an org may have just been left or deleted.
 */
export function useMe(): { me: Me | undefined; fresh: boolean; error: string | null; reload: () => void } {
  const { data, fresh, error, reload } = useApi('me', api.me);
  return { me: data, fresh, error, reload };
}

/** The org named in the URL, as the signed-in user sees it, and remembers it as the last one opened. */
export function useOrg(): { org: Org | undefined; orgId: string; error: string | null; reload: () => void } {
  const { orgId = '' } = useParams();
  const { data, error, reload } = useApi(`org:${orgId}`, () => api.org(orgId));
  useEffect(() => { if (data) rememberOrg(data.id); }, [data]);
  return { org: data, orgId, error, reload };
}
