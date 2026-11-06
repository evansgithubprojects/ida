// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearApiCache, useApi } from '../src/cloud/useApi';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A request the test answers by hand, so it controls when (and in which order) responses arrive. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

type Seen = { data: unknown; fresh: boolean; reload: () => void };
let root: Root;
let host: HTMLElement;
const seen: Record<string, Seen> = {};

/** Renders one probe per entry: `name` reads `key` with `load`, and reports what it sees into `seen[name]`. */
function render(probes: { name: string; key: string; load: () => Promise<unknown> }[]) {
  function Probe({ name, apiKey, load }: { name: string; apiKey: string; load: () => Promise<unknown> }) {
    const r = useApi(apiKey, load);
    useEffect(() => { seen[name] = { data: r.data, fresh: r.fresh, reload: r.reload }; });
    return null;
  }
  act(() => root.render(probes.map((p) => createElement(Probe, { key: p.name, name: p.name, apiKey: p.key, load: p.load }))));
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  clearApiCache();
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));

describe('cached API results', () => {
  it('shows what was loaded before at once on a later visit, then refreshes it', async () => {
    render([{ name: 'a', key: 'k1', load: async () => 'first' }]);
    await settle();
    expect(seen.a).toMatchObject({ data: 'first', fresh: true });
    act(() => root.render(null));

    const later = deferred<string>();
    render([{ name: 'a', key: 'k1', load: () => later.promise }]);
    // The old result holds the page's shape, but it isn't fresh yet.
    expect(seen.a).toMatchObject({ data: 'first', fresh: false });
    later.resolve('second');
    await settle();
    expect(seen.a).toMatchObject({ data: 'second', fresh: true });
  });

  it('makes one request for components asking for the same thing', async () => {
    let calls = 0;
    const load = async () => { calls++; return 'shared'; };
    render([{ name: 'a', key: 'k2', load }, { name: 'b', key: 'k2', load }]);
    await settle();
    expect(calls).toBe(1);
    expect([seen.a!.data, seen.b!.data]).toEqual(['shared', 'shared']);
  });

  it('never shows one key\'s result under another', async () => {
    render([{ name: 'a', key: 'org:1', load: async () => 'org one' }]);
    await settle();
    const two = deferred<string>();
    render([{ name: 'a', key: 'org:2', load: () => two.promise }]);
    expect(seen.a!.data).toBeUndefined();
    two.resolve('org two');
    await settle();
    expect(seen.a!.data).toBe('org two');
  });

  it('keeps an answer from before an edit from replacing the one after it', async () => {
    const before = deferred<string>();
    const after = deferred<string>();
    const answers = [before, after];
    render([{ name: 'a', key: 'k3', load: () => answers.shift()!.promise }]);
    act(() => seen.a!.reload());
    after.resolve('after the edit');
    await settle();
    before.resolve('before the edit');
    await settle();
    expect(seen.a!.data).toBe('after the edit');
  });

  it('forgets everything when cleared, e.g. on sign-out', async () => {
    render([{ name: 'a', key: 'k4', load: async () => 'private' }]);
    await settle();
    act(() => root.render(null));
    clearApiCache();
    const pending = deferred<string>();
    render([{ name: 'a', key: 'k4', load: () => pending.promise }]);
    expect(seen.a!.data).toBeUndefined();
  });
});
