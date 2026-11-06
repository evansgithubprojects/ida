import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Org } from '../src/cloud/api';
import { can, orgToOpen, rememberOrg } from '../src/cloud/orgs';

const org = (id: string, personal = false): Org => ({ id, name: id, personal, role: 'owner', createdAt: '' });

function stubStorage() {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) });
}
afterEach(() => vi.unstubAllGlobals());

describe('which organization opens', () => {
  it('is the last one opened, while the user still belongs to it', () => {
    stubStorage();
    const orgs = [org('mine', true), org('acme'), org('globex')];
    rememberOrg('acme');
    expect(orgToOpen(orgs)?.id).toBe('acme');
    expect(orgToOpen(orgs.filter((o) => o.id !== 'acme'))?.id).toBe('mine');
  });

  it('falls back to the personal org, then to any, then to none', () => {
    stubStorage();
    expect(orgToOpen([org('acme'), org('mine', true)])?.id).toBe('mine');
    expect(orgToOpen([org('acme')])?.id).toBe('acme');
    expect(orgToOpen([])).toBeNull();
  });
});

describe('what each org role is shown', () => {
  it('lets owners and admins create projects and manage people, and only owners edit the org or ownership', () => {
    expect(['owner', 'admin', 'member'].map((r) => can.createProjects(r as never))).toEqual([true, true, false]);
    expect(['owner', 'admin', 'member'].map((r) => can.manageMembers(r as never))).toEqual([true, true, false]);
    expect(['owner', 'admin', 'member'].map((r) => can.editOrg(r as never))).toEqual([true, false, false]);
    expect(['owner', 'admin', 'member'].map((r) => can.touchOwner(r as never))).toEqual([true, false, false]);
  });
});
