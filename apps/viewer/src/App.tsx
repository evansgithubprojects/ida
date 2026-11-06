import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router';
import { RequireAuth, useSession } from './cloud/auth';
import { supabase } from './cloud/supabase';
import { Logo } from './components/Logo';
import { OrgSwitcher } from './components/OrgSwitcher';
import { PendingInvites } from './components/PendingInvites';
import { AcceptInvite } from './pages/AcceptInvite';
import { Local } from './pages/Local';
import { Project } from './pages/Project';
import { NewOrg, OrgMembers, OrgProjects, OrgSettings, ProjectsRedirect } from './pages/Orgs';
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
        <Route path="/projects" element={<Shell><RequireAuth><ProjectsRedirect /></RequireAuth></Shell>} />
        <Route path="/invites/:token" element={<Shell><RequireAuth><AcceptInvite /></RequireAuth></Shell>} />
        <Route path="/orgs/new" element={<Shell><RequireAuth><NewOrg /></RequireAuth></Shell>} />
        <Route path="/orgs/:orgId" element={<Shell><RequireAuth><OrgProjects /></RequireAuth></Shell>} />
        <Route path="/orgs/:orgId/members" element={<Shell><RequireAuth><OrgMembers /></RequireAuth></Shell>} />
        <Route path="/orgs/:orgId/settings" element={<Shell><RequireAuth><OrgSettings /></RequireAuth></Shell>} />
        <Route path="/projects/:projectId" element={<Shell><RequireAuth><Project /></RequireAuth></Shell>} />
        {/* The connect walkthrough is a dialog on the project page now. */}
        <Route path="/projects/:projectId/connect" element={<Navigate to=".." relative="path" replace />} />
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
  const { pathname } = useLocation();
  const inOrg = pathname.startsWith('/orgs/');
  // The invite page already shows its invitation; the banner would repeat it.
  const onInvite = pathname.startsWith('/invites/');
  return (
    <div className="shell">
      <header className="toolbar">
        <h1><Link to="/" aria-label="Ida home"><Logo /></Link></h1>
        {supabase && session && <OrgSwitcher />}
        {/* Org pages are where projects live, so they count as "Projects" too. */}
        {supabase && <NavLink to="/projects" className={({ isActive }) => (isActive || inOrg ? 'active' : '')}>Projects</NavLink>}
        <NavLink to="/local">Local</NavLink>
        <span className="spacer" />
        {session && (
          <>
            <span className="muted">{session.user.email}</span>
            <button onClick={() => void supabase?.auth.signOut()}>Sign out</button>
          </>
        )}
      </header>
      {supabase && session && !onInvite && <PendingInvites />}
      <main className="shell-body">{children}</main>
    </div>
  );
}
