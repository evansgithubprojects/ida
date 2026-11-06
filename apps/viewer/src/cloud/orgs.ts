import { useCallback, useEffect, useState } from 'react';
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

/** The signed-in user and their orgs. `reload` after creating, renaming, leaving or deleting an org. */
export function useMe(): { me: Me | undefined; error: string | null; reload: () => void } {
  const { data, error, reload } = useApi(api.me, []);
  return { me: data, error, reload };
}

/** The org named in the URL, as the signed-in user sees it, and remembers it as the last one opened. */
export function useOrg(): { org: Org | undefined; orgId: string; error: string | null; reload: () => void } {
  const { orgId = '' } = useParams();
  const [version, setVersion] = useState(0);
  const { data, error } = useApi(() => api.org(orgId), [orgId, version]);
  useEffect(() => { if (data) rememberOrg(data.id); }, [data]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { org: data, orgId, error, reload };
}
