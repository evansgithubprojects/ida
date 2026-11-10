import { Link } from 'react-router';
import { useSession } from '../cloud/auth';
import { supabase } from '../cloud/supabase';
import { LogoMark } from '../components/Logo';

/** Nodes of the hero's event web: handlers, with the last one the root cause the pulse travels back to. */
const NODES = [
  { id: 'click', x: 70, y: 70, label: 'onCheckout' },
  { id: 'cart', x: 230, y: 40, label: 'cart.update' },
  { id: 'pay', x: 230, y: 150, label: 'payments.charge', below: true },
  { id: 'audit', x: 400, y: 70, label: 'audit.log' },
  { id: 'fail', x: 400, y: 170, label: 'card.declined', root: true },
] as const;

/** Event routes in firing order; each pulse starts when the one before it ends. */
const EDGES = [
  ['click', 'cart'],
  ['click', 'pay'],
  ['cart', 'audit'],
  ['pay', 'fail'],
] as const;

const at = (id: string) => NODES.find((n) => n.id === id)!;

function WebDemo() {
  return (
    <svg className="home-web" viewBox="0 0 480 220" role="img" aria-label="Events branching between handlers, with a pulse tracing a failure back to its source">
      {EDGES.map(([a, b], i) => {
        const p = at(a);
        const q = at(b);
        const d = `M${p.x} ${p.y}L${q.x} ${q.y}`;
        return (
          <g key={d} className={'root' in q ? 'web-bad' : undefined} style={{ ['--i' as string]: i }}>
            <path className="web-edge" d={d} />
            <path className="web-pulse" d={d} pathLength={1} />
          </g>
        );
      })}
      {NODES.map((n) => (
        <g key={n.id} className={'root' in n ? 'web-node web-root' : 'web-node'} transform={`translate(${n.x} ${n.y})`}>
          <circle r={'root' in n ? 9 : 7} />
          <text y={'below' in n ? 26 : -16} textAnchor="middle">{n.label}</text>
        </g>
      ))}
    </svg>
  );
}

const FEATURES = [
  {
    title: 'Record',
    body: 'One line hooks your emitters. Ida records who emitted, who handled it and what it carried, inside a window you choose.',
  },
  {
    title: 'Visualize',
    body: 'Handlers become nodes and events become pathways, so you can visualize how a single handler sits in many chains: a web, not a list.',
  },
  {
    title: 'Replay',
    body: 'Play, pause and scrub through the timeline as pathways light up. Replay your app\'s lifecycle without running any code.',
  },
  {
    title: 'Inspect',
    body: 'Start from processes, drop into a process to see its handlers, then inspect one handler for payloads, timings and errors.',
  },
];

const STEPS = [
  { n: '1', title: 'Install', body: 'Add the core package and the adapter for your emitters.' },
  { n: '2', title: 'Enable', body: 'Call enable() once. No instrumenting emit calls one by one.' },
  { n: '3', title: 'Watch', body: 'Open your project and watch events arrive live.' },
];

export function Home() {
  const session = useSession();
  const signedIn = !!supabase && !!session;
  const cta = signedIn ? { to: '/projects', label: 'Open your projects' } : { to: '/login', label: 'Get started' };

  return (
    <div className="landing">
      <section className="landing-hero">
        <div className="landing-copy">
          <LogoMark size={44} />
          <p className="eyebrow">Event debugging for JavaScript</p>
          <h2>Dig up the root.</h2>
          <p className="lede">
            Ida records every event in your app, shows how they branch, and replays them so you can trace
            any one of them back to where it started.
          </p>
          <div className="landing-actions">
            <Link className="cta primary" to={cta.to}>{cta.label}</Link>
            <a className="cta" href="#how">See how it works</a>
          </div>
        </div>
        <WebDemo />
      </section>

      <section className="landing-section">
        <h3>Follow the chain, not the log lines</h3>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <article key={f.title} className="feature">
              <h4>{f.title}</h4>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-section" id="how">
        <h3>Up and running in a minute</h3>
        <ol className="steps">
          {STEPS.map((s) => (
            <li key={s.n}>
              <span className="step-n">{s.n}</span>
              <div>
                <strong>{s.title}</strong>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <pre className="snippet landing-snippet">{`npm install @ida-dev/core @ida-dev/adapter-eventemitter

import { enable } from '@ida-dev/core';
import { enableEventEmitterRecording } from '@ida-dev/adapter-eventemitter';

enable();
enableEventEmitterRecording();`}</pre>
      </section>

      <section className="landing-final">
        <h3>Ready to find what's underneath?</h3>
        <Link className="cta primary" to={cta.to}>{cta.label}</Link>
      </section>
    </div>
  );
}
