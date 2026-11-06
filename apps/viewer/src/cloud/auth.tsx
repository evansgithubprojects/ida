import type { Session } from '@supabase/supabase-js';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { supabase } from './supabase';
import { clearApiCache } from './useApi';

/** The last session read, so pages mounted later start with it instead of a "Loading…" while it is read again. */
let known: Session | null | undefined = supabase ? undefined : null;
let knownUser: string | null | undefined;

/** Keeps `known` current and forgets cached API results whenever a different person (or nobody) is signed in. */
function remember(s: Session | null) {
  known = s;
  const user = s?.user.id ?? null;
  if (knownUser !== undefined && user !== knownUser) clearApiCache();
  knownUser = user;
}

/** The signed-in Supabase session: `undefined` while it is first read, `null` when signed out. */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(known);
  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => { remember(data.session); setSession(data.session); });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => { remember(s); setSession(s); });
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

/** Renders `children` for a signed-in user, else sends them to sign in and back here afterwards. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (!supabase) return <NotConfigured />;
  // Only on the very first page load: blank rather than text, since the page's own placeholder follows at once.
  if (session === undefined) return <div className="page" aria-busy="true" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function NotConfigured() {
  return (
    <div className="page">
      <h2>Projects aren't set up here</h2>
      <p>
        Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in <code>apps/viewer/.env.local</code> (see
        <code> .env.example</code>), then restart the dev server.
      </p>
    </div>
  );
}
