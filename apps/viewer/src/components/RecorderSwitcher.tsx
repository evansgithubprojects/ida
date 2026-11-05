import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../cloud/api';
import { useApi } from '../cloud/useApi';

/** The recorder's name and its processes as a row's subheading, so the list reads as what each recorder contains. */
export function processSummary(processes: string[]): string {
  return processes.length ? processes.join(', ') : 'No processes yet';
}

/** Top-left of the graph: the current recorder, and a list of the project's others to switch to. */
export function RecorderSwitcher({ projectId, recorderKey }: { projectId: string; recorderKey: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const recorders = useApi(() => api.recorders(projectId), [projectId], 10_000);
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

  return (
    <div ref={box} className="recorder-switcher">
      <button className="recorder-switcher-button" aria-haspopup="listbox" aria-expanded={open} title="Switch recorder" onClick={() => setOpen((o) => !o)}>
        <code>{recorderKey}</code>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="recorder-switcher-panel" role="listbox" aria-label="Recorders" onKeyDown={onListKey}>
          {recorders.error && !rows.length && <p className="hint">{recorders.error}</p>}
          {rows.map((r) => (
            <button key={r.key} className="recorder-row" role="option" aria-selected={r.key === recorderKey} aria-current={r.key === recorderKey ? 'true' : undefined} onClick={() => choose(r.key)}>
              <span className="recorder-name">
                <code>{r.key}</code>
                {r.live && <i className="recorder-live" title="Live" />}
              </span>
              <small className="recorder-processes" title={r.processes.join(', ')}>{processSummary(r.processes)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
