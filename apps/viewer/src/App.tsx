import { BrowserRouter, Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, useParams, useSearchParams } from 'react-router';
import { RequireAuth, useSession } from './cloud/auth';
import { supabase } from './cloud/supabase';
import { Logo } from './components/Logo';
import { PendingInvites } from './components/PendingInvites';
import { Docs } from './pages/Docs';
import { Home } from './pages/Home';
import { AcceptInvite } from './pages/AcceptInvite';
import { Project } from './pages/Project';
import { NewOrg, OrgLayout, OrgMembers, OrgProfile, OrgProjects, OrgSettings, ProjectsRedirect } from './pages/Orgs';
import { ProjectView } from './pages/View';
import { SignIn } from './pages/SignIn';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/local" element={<Navigate to="/" replace />} />
        {/* Every page with the header shares one shell. */}
        <Route element={<Shell />}>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<SignIn />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="/docs/*" element={<Docs />} />
          <Route path="/projects" element={<RequireAuth><ProjectsRedirect /></RequireAuth>} />
          <Route path="/invites/:token" element={<RequireAuth><AcceptInvite /></RequireAuth>} />
          <Route path="/orgs" element={<RequireAuth><ProjectsRedirect /></RequireAuth>} />
          <Route path="/orgs/new" element={<RequireAuth><NewOrg /></RequireAuth>} />
          <Route path="/orgs/:orgId" element={<RequireAuth><OrgLayout /></RequireAuth>}>
            <Route index element={<OrgProjects />} />
            <Route path="members" element={<OrgMembers />} />
            <Route path="settings" element={<OrgSettings />} />
            <Route path="profile" element={<OrgProfile />} />
          </Route>
          <Route path="/projects/:projectId" element={<RequireAuth><Project /></RequireAuth>} />
          <Route path="*" element={<div className="page"><h2>Not found</h2><Link to="/">Home</Link></div>} />
        </Route>
        {/* The connect walkthrough is a dialog on the project page now. */}
        <Route path="/projects/:projectId/connect" element={<Navigate to=".." relative="path" replace />} />
        {/* The viewer fills the window, so it brings its own header. */}
        <Route path="/projects/:projectId/view" element={<RequireAuth><ProjectView /></RequireAuth>} />
        {/* The recorder and system screens are one viewer now: old links open it zoomed into the same place. */}
        <Route path="/projects/:projectId/recorders/:recorderKey" element={<ToView />} />
        <Route path="/projects/:projectId/recorders/:recorderKey/live" element={<ToView />} />
        <Route path="/projects/:projectId/recorders/:recorderKey/sessions/:sessionId" element={<ToView />} />
        <Route path="/projects/:projectId/system" element={<ToView />} />
      </Routes>
    </BrowserRouter>
  );
}

/** An old recorder, session or system URL, sent to the viewer with the same service, run and span. */
function ToView() {
  const { projectId = '', recorderKey, sessionId } = useParams();
  const [params] = useSearchParams();
  const q = new URLSearchParams();
  if (recorderKey) q.set('service', recorderKey);
  if (sessionId) q.set('run', sessionId);
  const span = params.get('span');
  if (span) q.set('span', span);
  const query = q.toString();
  return <Navigate to={`/projects/${projectId}/view${query ? `?${query}` : ''}`} replace />;
}

function Shell() {
  const session = useSession();
  const { pathname } = useLocation();
  // The invite page already shows its invitation; the banner would repeat it.
  const onInvite = pathname.startsWith('/invites/');
  return (
    <div className="shell">
      <header className="toolbar">
        <h1><Link to="/" aria-label="Ida home"><Logo /></Link></h1>
        {supabase && session && <NavLink to="/orgs">Dashboard</NavLink>}
        <NavLink to="/docs">Docs</NavLink>
        <span className="spacer" />
        {session && (
          <>
            <span className="muted">{session.user.email}</span>
            <button onClick={() => void supabase?.auth.signOut()}>Sign out</button>
          </>
        )}
        {supabase && session === null && pathname !== '/login' && (
          <Link className="cta login-btn" to="/login">Log in</Link>
        )}
      </header>
      {supabase && session && !onInvite && <PendingInvites />}
      <main className="shell-body"><Outlet /></main>
    </div>
  );
}
