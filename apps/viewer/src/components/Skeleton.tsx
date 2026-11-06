/*
 * Placeholders shown while a page's data loads for the first time. Each one reuses the real page's markup (headings,
 * tabs, cards, tables) with grey bars where the text will be, so the real content replaces it without moving anything.
 * Revisits don't need them: useApi shows the cached result straight away.
 */

/** A grey bar the height of one line of the surrounding text. */
export function Bone({ w }: { w: string }) {
  return <span className="bone" style={{ width: w }} aria-hidden="true" />;
}

/** Wraps a placeholder so screen readers hear one "Loading" instead of empty shapes. */
function Loading({ children, className = 'page' }: { children: React.ReactNode; className?: string }) {
  return <div className={className} role="status" aria-busy="true" aria-label="Loading">{children}</div>;
}

/** An org page: its name, the "You are …" line and the tabs (`tabs`: their labels), then project cards. */
export function OrgPageSkeleton({ tabs }: { tabs: readonly string[] }) {
  return (
    <Loading>
      <div className="page-head">
        <h2><Bone w="7em" /></h2>
        <span className="muted"><Bone w="8em" /></span>
      </div>
      <nav className="org-tabs" aria-hidden="true">
        {/* The tab names never change, so they show for real; only where they lead is unknown yet. */}
        {tabs.map((t) => <a key={t}>{t}</a>)}
      </nav>
      <CardsSkeleton />
    </Loading>
  );
}

/** Project cards: a name and a "1 recorder · just now" line each. */
export function CardsSkeleton({ count = 2 }: { count?: number }) {
  return (
    <ul className="cards" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <div className="card">
            <strong><Bone w={i % 2 ? '5em' : '7em'} /></strong>
            <span className="muted"><Bone w="9em" /></span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** A table with its real column headings and a few rows of bars. */
export function TableSkeleton({ heads, rows = 3 }: { heads: string[]; rows?: number }) {
  return (
    <table className="table" aria-hidden="true">
      <thead><tr>{heads.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
      <tbody>
        {Array.from({ length: rows }, (_, r) => (
          <tr key={r}>{heads.map((_, c) => <td key={c}><Bone w={c === 0 ? `${[9, 7, 11][r % 3]}em` : '5em'} /></td>)}</tr>
        ))}
      </tbody>
    </table>
  );
}

/** A project page: breadcrumbs, name and the Recorders panel. */
export function ProjectSkeleton() {
  return (
    <Loading>
      <nav className="crumbs"><Bone w="4em" /><span>›</span><Bone w="6em" /></nav>
      <div className="page-head"><h2><Bone w="6em" /></h2></div>
      <section className="panel-section">
        <h3>Recorders</h3>
        <TableSkeleton heads={['Key', 'Last data']} rows={2} />
      </section>
    </Loading>
  );
}

/** A narrow page such as an invitation: a heading and a line of text. */
export function NarrowSkeleton() {
  return (
    <Loading className="page narrow">
      <h2><Bone w="8em" /></h2>
      <p><Bone w="100%" /></p>
    </Loading>
  );
}
