import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../cloud/api';
import { useApi } from '../cloud/useApi';
import { useStore } from '../store';
import type { RecordingSource } from './RecordingsDialog';

/** The recorder's name and its processes as a row's subheading, so the list reads as what each recorder contains. */
export function processSummary(processes: string[]): string {
  return processes.length ? processes.join(', ') : 'No processes yet';
}

/** Top-left of the graph: the current recorder, a list of the project's others to switch to, and a way to view a remote endpoint instead. */
export function RecorderSwitcher({ projectId, recorderKey, source, onSource }: {
  projectId: string;
  recorderKey: string;
  source: RecordingSource;
  onSource: (source: RecordingSource) => void;
}) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(source.kind === 'endpoint' ? source.url : 'http://127.0.0.1:7777');
  const status = useStore((s) => s.live);
  const endpoint = source.kind === 'endpoint' ? source : null;
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
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

  const choose = (key: string) => {
    setOpen(false);
    if (endpoint && key === recorderKey) onSource({ kind: 'cloud' });
    if (key !== recorderKey) navigate(`/projects/${projectId}/recorders/${encodeURIComponent(key)}/live`);
  };
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
      <button className="recorder-switcher-button" aria-haspopup="listbox" aria-expanded={open} title={endpoint ? 'Viewing a remote endpoint' : 'Switch recorder'} onClick={() => setOpen((o) => !o)}>
        <code>{endpoint ? endpoint.url : recorderKey}</code>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="recorder-switcher-panel">
         <div role="listbox" aria-label="Recorders" onKeyDown={onListKey}>
          {recorders.error && !rows.length && <p className="hint">{recorders.error}</p>}
          {rows.map((r) => (
            <button key={r.key} className="recorder-row" role="option" aria-selected={!endpoint && r.key === recorderKey} aria-current={!endpoint && r.key === recorderKey ? 'true' : undefined} onClick={() => choose(r.key)}>
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
