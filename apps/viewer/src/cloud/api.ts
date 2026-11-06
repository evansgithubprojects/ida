import type { Recording } from '@eda-debugger/core';
import { API_URL, supabase } from './supabase';

export interface Project { id: string; name: string; orgId: string; /** What the signed-in user may do here. Only sent when fetching one project. */ access?: 'viewer' | 'editor' | 'admin'; createdAt: string; recorders?: number; lastSeenAt?: string | null }
export interface IngestKey { id: string; prefix: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }
export interface RecorderSummary { key: string; createdAt: string; lastSeenAt: string; sessions: number; live: boolean; /** Top-level process names in the newest session. */ processes: string[] }
export interface SessionSummary { id: string; startedAt: number; runtime: string; lastSeenAt: string; occurrences: number; late: number; gaps: number; live: boolean }

export type OrgRole = 'owner' | 'admin' | 'member';
export interface Org { id: string; name: string; personal: boolean; role: OrgRole; createdAt: string }
export interface Me { user: { id: string; email: string | null; name: string | null }; orgs: Org[] }
export interface OrgProject { id: string; name: string; orgId: string; createdAt: string; recorders: number; lastSeenAt: string | null }
export interface Member { userId: string; email: string | null; name: string | null; role: OrgRole; joinedAt: string }

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = (await supabase?.auth.getSession())?.data.session?.access_token;
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, `Can't reach the server at ${API_URL}.`);
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

const o = (orgId: string) => `/v1/orgs/${encodeURIComponent(orgId)}`;
const p = (projectId: string) => `/v1/projects/${encodeURIComponent(projectId)}`;
const r = (projectId: string, key: string) => `${p(projectId)}/recorders/${encodeURIComponent(key)}`;

export const api = {
  me: () => request<Me>('GET', '/v1/me'),
  createOrg: (name: string) => request<Org>('POST', '/v1/orgs', { name }),
  org: (id: string) => request<Org>('GET', o(id)),
  renameOrg: (id: string, name: string) => request<Org>('PATCH', o(id), { name }),
  deleteOrg: (id: string) => request<void>('DELETE', o(id)),
  orgProjects: (id: string) => request<OrgProject[]>('GET', `${o(id)}/projects`),
  createOrgProject: (id: string, name: string) => request<Project>('POST', `${o(id)}/projects`, { name }),
  members: (id: string) => request<Member[]>('GET', `${o(id)}/members`),
  setMemberRole: (id: string, userId: string, role: OrgRole) => request<{ userId: string; role: OrgRole }>('PATCH', `${o(id)}/members/${encodeURIComponent(userId)}`, { role }),
  removeMember: (id: string, userId: string) => request<void>('DELETE', `${o(id)}/members/${encodeURIComponent(userId)}`),
  projects: () => request<Project[]>('GET', '/v1/projects'),
  createProject: (name: string) => request<Project>('POST', '/v1/projects', { name }),
  project: (id: string) => request<Project>('GET', p(id)),
  renameProject: (id: string, name: string) => request<Project>('PATCH', p(id), { name }),
  deleteProject: (id: string) => request<void>('DELETE', p(id)),
  keys: (id: string) => request<IngestKey[]>('GET', `${p(id)}/keys`),
  createKey: (id: string, label: string) => request<IngestKey & { key: string }>('POST', `${p(id)}/keys`, { label }),
  revokeKey: (id: string, keyId: string) => request<void>('DELETE', `${p(id)}/keys/${keyId}`),
  recorders: (id: string) => request<RecorderSummary[]>('GET', `${p(id)}/recorders`),
  sessions: (id: string, key: string) => request<SessionSummary[]>('GET', `${r(id, key)}/sessions`),
  recording: (sessionId: string) => request<Recording>('GET', `/v1/sessions/${sessionId}/recording`),
  /** A URL for the recorder's live stream, valid to connect to for a minute. */
  liveUrl: async (id: string, key: string) => {
    const { token } = await request<{ token: string }>('POST', `${r(id, key)}/stream-token`);
    return `${API_URL}/v1/live?token=${encodeURIComponent(token)}`;
  },
};
