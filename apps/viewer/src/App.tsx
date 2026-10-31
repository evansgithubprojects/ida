import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from 'react-router';
import { RequireAuth, useSession } from './cloud/auth';
import { supabase } from './cloud/supabase';
import { Connect } from './pages/Connect';
import { Local } from './pages/Local';
import { Project } from './pages/Project';
import { Projects } from './pages/Projects';
import { Recorder } from './pages/Recorder';
import { Session } from './pages/Session';
import { SignIn } from './pages/SignIn';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to={supabase ? '/projects' : '/local'} replace />} />
        <Route path="/local" element={<Local />} />
        <Route path="/login" element={<Shell><SignIn /></Shell>} />
        <Route path="/projects" element={<Shell><RequireAuth><Projects /></RequireAuth></Shell>} />
        <Route path="/projects/:projectId" element={<Shell><RequireAuth><Project /></RequireAuth></Shell>} />
        <Route path="/projects/:projectId/connect" element={<Shell><RequireAuth><Connect /></RequireAuth></Shell>} />
        <Route path="/projects/:projectId/recorders/:recorderKey" element={<Shell><RequireAuth><Recorder /></RequireAuth></Shell>} />
        {/* The replay screens fill the window, so they bring their own header. */}
        <Route path="/projects/:projectId/recorders/:recorderKey/live" element={<RequireAuth><Session live /></RequireAuth>} />
        <Route path="/projects/:projectId/recorders/:recorderKey/sessions/:sessionId" element={<RequireAuth><Session /></RequireAuth>} />
        <Route path="*" element={<Shell><div className="page"><h2>Not found</h2><Link to="/">Home</Link></div></Shell>} />
      </Routes>
    </BrowserRouter>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const session = useSession();
  return (
    <div className="shell">
      <header className="toolbar">
        <h1><Link to="/">Event Chain Debugger</Link></h1>
        {supabase && <NavLink to="/projects">Projects</NavLink>}
        <NavLink to="/local">Local</NavLink>
        <span className="spacer" />
        {session && (
          <>
            <span className="muted">{session.user.email}</span>
            <button onClick={() => void supabase?.auth.signOut()}>Sign out</button>
          </>
        )}
      </header>
      <main className="shell-body">{children}</main>
    </div>
  );
}
