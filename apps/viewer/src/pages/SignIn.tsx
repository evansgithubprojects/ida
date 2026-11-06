import { useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useSession } from '../cloud/auth';
import { supabase } from '../cloud/supabase';
import { LogoMark } from '../components/Logo';

const FADE_MS = 600; // matches the background-color transition on .shell:has(.hero) in styles.css

export function SignIn() {
  const session = useSession();
  const location = useLocation();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  // After a successful sign-in the darker landing background fades up to the app's color before we leave.
  const [fading, setFading] = useState(false);

  if (session && !fading) return <Navigate to={(location.state as { from?: string } | null)?.from ?? '/projects'} replace />;
  if (!supabase) return <Navigate to="/projects" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    const { data, error } = mode === 'in'
      ? await supabase!.auth.signInWithPassword({ email, password })
      : await supabase!.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/projects` } });
    if (data?.session && !error) {
      setFading(true);
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setTimeout(() => setFading(false), reduced ? 0 : FADE_MS);
      return;
    }
    setBusy(false);
    if (error) return setMessage({ tone: 'error', text: error.message });
    // Sign-ups have to confirm their address first; there is no session until then.
    if (mode === 'up' && !data.session) setMessage({ tone: 'info', text: `Check ${email} for a link to confirm your account, then sign in.` });
  };

  return (
    <div className="page narrow">
      <div className={fading ? 'hero signed-in' : 'hero'}>
        <LogoMark size={56} />
        <h2>{mode === 'in' ? 'Welcome to Ida' : 'Grow with Ida'}</h2>
        <p>Record every event in your app, watch how they branch, and trace each one back to its roots.</p>
      </div>
      <form className="form" onSubmit={submit}>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>
          Password
          <input type="password" autoComplete={mode === 'in' ? 'current-password' : 'new-password'} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {message && <p className={message.tone === 'error' ? 'form-error' : 'hint'} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
        <button className="primary" disabled={busy}>{busy ? '…' : mode === 'in' ? 'Sign in' : 'Create account'}</button>
      </form>
      <p className="muted">
        {mode === 'in' ? 'No account yet? ' : 'Already have one? '}
        <button className="link" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setMessage(null); }}>
          {mode === 'in' ? 'Create one' : 'Sign in'}
        </button>
      </p>
    </div>
  );
}
