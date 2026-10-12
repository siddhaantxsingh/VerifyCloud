import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";

import { get, post } from "./api";
import { Loading } from "./components/ui";
import { Dashboard } from "./pages/Dashboard";
import { Login, Register } from "./pages/Auth";
import { NewProject, ProjectPage, ProjectSettings } from "./pages/Project";
import { RunPage } from "./pages/Run";
import { TaskPage } from "./pages/Task";
import { OrgSettings, Tokens, Usage, Audit, Workers } from "./pages/Settings";
import { CompareProject } from "./pages/Compare";

export interface Me {
  user: { id: string; email: string; name: string; emailVerified: boolean; githubLogin: string | null; platformAdmin: boolean } | null;
  organizations: { id: string; slug: string; name: string; plan: string; is_demo: boolean; role: string }[];
  features: { githubLogin: boolean; githubApp: boolean; publicDemo: boolean; email: boolean };
}

const MeCtx = createContext<{ me: Me | null; refresh: () => Promise<void> }>({ me: null, refresh: async () => {} });
export const useMe = () => useContext(MeCtx);

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = async () => {
    try {
      setMe(await get<Me>("/me"));
    } catch {
      setMe(null);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  if (me === undefined) return <div className="center"><Loading /></div>;
  return (
    <MeCtx.Provider value={{ me, refresh }}>
      <Routes>
        <Route path="/login" element={me ? <Navigate to="/" replace /> : <Login />} />
        <Route path="/register" element={me ? <Navigate to="/" replace /> : <Register />} />
        <Route path="/*" element={me ? <Shell /> : <RedirectToLogin />} />
      </Routes>
    </MeCtx.Provider>
  );
}

function RedirectToLogin() {
  const loc = useLocation();
  return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
}

function Shell() {
  const { me } = useMe();
  const nav = useNavigate();
  const loc = useLocation();
  const orgFromPath = /^\/o\/([^/]+)/.exec(loc.pathname)?.[1];
  const [org, setOrg] = useState<string | undefined>(orgFromPath ?? me?.organizations[0]?.slug);
  useEffect(() => {
    if (orgFromPath) setOrg(orgFromPath);
  }, [orgFromPath]);
  const current = me?.organizations.find((o) => o.slug === org);
  return (
    <div className="shell">
      <a href="#main" className="skip">Skip to content</a>
      <header className="topbar">
        <Link to={org ? `/o/${org}` : "/"} className="brand" aria-label="VerifyCloud home">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="var(--accent)" /><path d="M7 17l6 6L25 9" stroke="white" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
          VerifyCloud
        </Link>
        {me && me.organizations.length > 0 && (
          <label className="orgpick">
            <span className="sr">Organization</span>
            <select value={org} onChange={(e) => nav(`/o/${e.target.value}`)}>
              {me.organizations.map((o) => <option key={o.id} value={o.slug}>{o.name}</option>)}
            </select>
          </label>
        )}
        {org && (
          <nav className="mainnav" aria-label="Main">
            <NavLink to={`/o/${org}`} end>Dashboard</NavLink>
            <NavLink to={`/o/${org}/usage`}>Usage</NavLink>
            {current && ["owner", "admin"].includes(current.role) && <NavLink to={`/o/${org}/settings`}>Settings</NavLink>}
            {current && ["owner", "admin"].includes(current.role) && <NavLink to={`/o/${org}/audit`}>Audit</NavLink>}
            <NavLink to="/workers">Workers</NavLink>
          </nav>
        )}
        <div className="spacer" />
        <NavLink to="/me/tokens" className="small">Tokens</NavLink>
        <span className="small muted">{me?.user?.email}</span>
        <button className="btn tiny" onClick={async () => { await post("/auth/logout"); window.location.href = "/login"; }}>Log out</button>
      </header>
      {current?.is_demo && <div className="demobar">Demo organization: the AXI4-Lite project ships with one intentional bug. Run the <b>full</b> regression, open a failing test and ask for an analysis.</div>}
      <main id="main" className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/o/:org" element={<Dashboard />} />
          <Route path="/o/:org/new-project" element={<NewProject />} />
          <Route path="/o/:org/settings" element={<OrgSettings />} />
          <Route path="/o/:org/usage" element={<Usage />} />
          <Route path="/o/:org/audit" element={<Audit />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/projects/:id/settings" element={<ProjectSettings />} />
          <Route path="/projects/:id/compare" element={<CompareProject />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/tasks/:id" element={<TaskPage />} />
          <Route path="/me/tokens" element={<Tokens />} />
          <Route path="/workers" element={<Workers />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
    </div>
  );
}

function Home() {
  const { me } = useMe();
  if (me?.organizations[0]) return <Navigate to={`/o/${me.organizations[0].slug}`} replace />;
  return <CreateOrg />;
}

function CreateOrg() {
  const { refresh } = useMe();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="narrow">
      <h1>Create an organization</h1>
      <p className="muted">Projects, members, quotas and billing belong to an organization.</p>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await post("/orgs", { name, slug });
            await refresh();
            nav(`/o/${slug}`);
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      >
        <label>Name<input value={name} onChange={(e) => { setName(e.target.value); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)); }} required /></label>
        <label>Slug<input value={slug} onChange={(e) => setSlug(e.target.value)} pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" required /></label>
        {err && <div className="alert bad" role="alert">{err}</div>}
        <button className="btn primary">Create</button>
      </form>
    </div>
  );
}

function NotFound() {
  return (
    <div className="narrow">
      <h1>Not found</h1>
      <p>This page does not exist, or you do not have access to it.</p>
      <Link to="/">Go to the dashboard</Link>
    </div>
  );
}

export function RequireRole({ org, roles, children }: { org?: string; roles: string[]; children: ReactNode }) {
  const { me } = useMe();
  const p = useParams();
  const o = me?.organizations.find((x) => x.slug === (org ?? p.org));
  if (!o || !roles.includes(o.role)) return null;
  return <>{children}</>;
}
