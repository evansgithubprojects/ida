import { Link, NavLink, useParams } from 'react-router';
import { API_URL } from '../cloud/supabase';
import { SETUPS, SOURCES, languagesFor, type Source } from '../components/SetupSnippet';

/** What a broker integration records and how it links services, beyond the setup itself. */
const BROKER_NOTES: Partial<Record<Source, string[]>> = {
  kafka: [
    'Each produce is recorded on its topic, emitted by the handler that was running, and adds an ida-parent header to the message.',
    'Each consumed message is recorded on its topic, handled by your code, and linked through that header to the produce in whichever service sent it, in any language.',
    'Topic, partition, offset and consumer group are kept with every message. Message keys are kept only when you turn on recordKeys (record_keys in Python).',
  ],
  rabbitmq: [
    'Each publish is recorded on its exchange and adds an ida-parent header to the message properties. Your own properties object is never changed.',
    'Each delivery is recorded on its queue, handled by your callback, and linked through that header to the publish in whichever service sent it, in any language.',
    'Exchange, routing key, queue and delivery tag are kept with every message.',
  ],
};

/** Setup for one event source in every language that supports it; `/docs` alone lists the sources. */
export function Docs() {
  const { integration } = useParams();
  const source = SOURCES.find((s) => s.id === integration);

  return (
    <div className="page docs">
      <nav className="docs-nav" aria-label="Integrations">
        {SOURCES.map((s) => <NavLink key={s.id} to={`/docs/${s.id}`}>{s.label}</NavLink>)}
      </nav>
      {!source ? (
        integration ? (
          <>
            <h2>No integration called “{integration}”</h2>
            <p><Link to="/docs">See what Ida can record</Link></p>
          </>
        ) : (
          <>
            <h2>Integrations</h2>
            <p className="muted">Pick what your app's events go through. Each page has the setup for every language that supports it.</p>
            <IntegrationGrid />
          </>
        )
      ) : (
        <>
          <h2>{source.label}</h2>
          <p className="lede">{source.blurb}</p>
          <p className="muted">
            Make an ingest key in your project first, and set it as <code>IDA_PROJECT_KEY</code>. Uploads go to <code>{API_URL}</code>.
          </p>
          {languagesFor(source.id).map((l) => {
            const setup = SETUPS[l.id][source.id]!;
            return (
              <section key={l.id} className="panel-section">
                <h3>{l.label}{setup.library && <span className="muted"> · {setup.library}</span>}</h3>
                <pre className="snippet">{`${setup.install}\n\n${setup.code('ida_…', API_URL)}`}</pre>
                {setup.example && (
                  <>
                    <h4>Then publish and consume as usual</h4>
                    <pre className="snippet">{setup.example}</pre>
                  </>
                )}
              </section>
            );
          })}
          {BROKER_NOTES[source.id] && (
            <section className="panel-section">
              <h3>What is recorded</h3>
              <ul>{BROKER_NOTES[source.id]!.map((n) => <li key={n}>{n}</li>)}</ul>
              <p className="muted">Open your project's <strong>System view</strong> to see every service together, with each message drawn from the service that sent it to the one that handled it.</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** One card per event source, linking to its docs page, with the languages that support it. */
export function IntegrationGrid() {
  return (
    <div className="feature-grid">
      {SOURCES.map((s) => (
        <Link key={s.id} to={`/docs/${s.id}`} className="feature integration">
          <h4>{s.label}</h4>
          <p>{s.blurb}</p>
          <p className="muted">{languagesFor(s.id).map((l) => l.label).join(' · ')}</p>
        </Link>
      ))}
    </div>
  );
}
