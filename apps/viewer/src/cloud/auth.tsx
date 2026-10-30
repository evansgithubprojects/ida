import type { Session } from '@supabase/supabase-js';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { supabase } from './supabase';

/** The signed-in Supabase session: `undefined` while it is being read, `null` when signed out. */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(supabase ? undefined : null);
  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return session;
}

/** Renders `children` for a signed-in user, else sends them to sign in and back here afterwards. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const session = useSession();
  const location = useLocation();
  if (!supabase) return <NotConfigured />;
  if (session === undefined) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function NotConfigured() {
  return (
    <div className="page">
      <h2>Projects aren't set up here</h2>
      <p>
        Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> in <code>apps/viewer/.env.local</code> (see
        <code> .env.example</code>), then restart the dev server. Local recordings still work under <a href="/local">Local</a>.
      </p>
    </div>
  );
}
