import { useEffect, useRef, useState } from 'react';
import { api } from '../cloud/api';
import { useApi } from '../cloud/useApi';
import { useStore } from '../store';
import type { RecordingSource } from './RecordingsDialog';

/** The recorder's name and its processes as a row's subheading, so the list reads as what each recorder contains. */
export function processSummary(processes: string[]): string {
  return processes.length ? processes.join(', ') : 'No processes yet';
}

/**
 * Top-left of the graph: the service in view (or all of them), the project's services to zoom into, and a way to
 * view a remote endpoint instead. `onPick(null)` goes back out to every service.
 */
export function RecorderSwitcher({ projectId, service, source, onSource, onPick }: {
  projectId: string;
  service: string | null;
  source: RecordingSource;
  onSource: (source: RecordingSource) => void;
  onPick: (service: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(source.kind === 'endpoint' ? source.url : 'http://127.0.0.1:7777');
  const status = useStore((s) => s.live);
  const endpoint = source.kind === 'endpoint' ? source : null;
  const box = useRef<HTMLDivElement>(null);
  const recorders = useApi(`recorders:${projectId}`, () => api.recorders(projectId), { pollMs: 10_000 });
  const rows = recorders.data ?? [];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const choose = (key: string | null) => {
    setOpen(false);
    if (source.kind !== 'cloud') onSource({ kind: 'cloud' });
    onPick(key);
  };
  const cloud = source.kind === 'cloud';
  // Arrow keys move between rows; Enter and Space activate the focused one like any button.
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...box.current!.querySelectorAll<HTMLButtonElement>('.recorder-row')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    const u = url.trim();
    if (!u) return;
    onSource({ kind: 'endpoint', url: u });
    setOpen(false);
  };

  return (
    <div ref={box} className="recorder-switcher">
      <button className="recorder-switcher-button" aria-haspopup="listbox" aria-expanded={open} title={endpoint ? 'Viewing a remote endpoint' : 'Switch service'} onClick={() => setOpen((o) => !o)}>
        {endpoint ? <code>{endpoint.url}</code> : source.kind === 'file' ? <code>{source.name}</code> : service ? <code>{service}</code> : <span>All services</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="recorder-switcher-panel">
         <div role="listbox" aria-label="Services" onKeyDown={onListKey}>
          {recorders.error && !rows.length && <p className="hint">{recorders.error}</p>}
          <button className="recorder-row" role="option" aria-selected={cloud && !service} aria-current={cloud && !service ? 'true' : undefined} onClick={() => choose(null)}>
            <span className="recorder-name">All services</span>
            <small className="recorder-processes">Every service, linked through their brokers</small>
          </button>
          {rows.map((r) => (
            <button key={r.key} className="recorder-row" role="option" aria-selected={cloud && r.key === service} aria-current={cloud && r.key === service ? 'true' : undefined} onClick={() => choose(r.key)}>
              <span className="recorder-name">
                <code>{r.key}</code>
                {r.live && <i className="recorder-live" title="Live" />}
              </span>
              <small className="recorder-processes" title={r.processes.join(', ')}>{processSummary(r.processes)}</small>
            </button>
          ))}
         </div>
          <div className="recorder-footer">
            {endpoint ? (
              <div className="endpoint-row">
                <code className="endpoint-url" title={endpoint.url}>{endpoint.url}</code>
                <span className={`live ${status === 'on' ? 'live-on' : ''}`}>● {status}</span>
                <button onClick={() => { onSource({ kind: 'cloud' }); setOpen(false); }}>Disconnect</button>
              </div>
            ) : (
              <form onSubmit={connect}>
                <label className="recorder-endpoint-label" htmlFor="endpoint-url">View Remote Endpoint</label>
                <div className="endpoint-row">
                  <input id="endpoint-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:7777" />
                  <button type="submit" className="primary">Connect</button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
