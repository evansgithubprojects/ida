import type { Recording } from '@ida-dev/core';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../cloud/api';
import { ago, useApi } from '../cloud/useApi';
import { TableSkeleton } from './Skeleton';

/** Where the replay screen's events come from: the recording its URL names, a local JSON export, or a `startBridge` stream. */
export type RecordingSource =
  | { kind: 'cloud' }
  | { kind: 'file'; name: string; recording: Recording }
  | { kind: 'endpoint'; url: string };

/** Reads a JSON export from `recorder.export()`; throws a message fit to show when it isn't one. */
export async function parseRecording(file: File): Promise<Recording> {
  let data: Recording;
  try {
    data = JSON.parse(await file.text()) as Recording;
  } catch {
    throw new Error('Could not read that file as JSON.');
  }
  if (!Array.isArray(data?.occurrences) || !Array.isArray(data.templates) || !Array.isArray(data.nodes)) {
    throw new Error('That file is not an Ida recording.');
  }
  return data;
}

type SourceProps = {
  projectId: string;
  recorderKey: string;
  /** The saved recording the URL names, if any. */
  currentSessionId?: string;
  source: RecordingSource;
  onSource: (source: RecordingSource) => void;
};

/** Lists a recorder's recordings, and opens a local export instead. Picking anything closes it. */
export function RecordingsDialog({ projectId, recorderKey, currentSessionId, source, onSource, onClose }: SourceProps & { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sessions = useApi(`sessions:${projectId}:${recorderKey}`, () => api.sessions(projectId, recorderKey), { pollMs: 10_000 });
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const base = `/projects/${projectId}/recorders/${encodeURIComponent(recorderKey)}`;
  const viewing = source.kind === 'cloud' ? currentSessionId : undefined;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const open = async (file: File) => {
    try {
      const recording = await parseRecording(file);
      onSource({ kind: 'file', name: file.name, recording });
      onClose();
    } catch (e) {
      setFileError((e as Error).message);
    }
  };

  return (
    <dialog
      ref={ref}
      className={`modal recordings-modal ${dragging ? 'dragging' : ''}`}
      aria-labelledby="recordings-title"
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      // A click on the dialog element itself (not its content) is a click on the backdrop.
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) void open(f);
      }}
    >
      <button className="icon modal-close" aria-label="Close" onClick={onClose}>×</button>
      <h3 id="recordings-title">Recordings · <code>{recorderKey}</code></h3>
      <p className="muted">Each run of your app is one recording.</p>
      {sessions.error && <p className="form-error" role="alert">{sessions.error}</p>}
      {!sessions.data && !sessions.error && <TableSkeleton heads={['Started', 'Events', 'Runtime', 'Last data', '', '']} />}
      {sessions.data?.length === 0 && <p className="muted">No recordings yet.</p>}
      {!!sessions.data?.length && (
        <div className="recordings-scroll">
          <table className="table">
            <thead><tr><th>Started</th><th>Events</th><th>Runtime</th><th>Last data</th><th /><th /></tr></thead>
            <tbody>
              {sessions.data.map((s) => (
                <tr key={s.id} aria-current={s.id === viewing ? 'true' : undefined}>
                  <td>
                    <Link to={`${base}/sessions/${s.id}`} onClick={() => { onSource({ kind: 'cloud' }); onClose(); }}>
                      {new Date(s.startedAt).toLocaleString()}
                    </Link>
                    {s.id === viewing && <span className="badge">viewing</span>}
                  </td>
                  <td>
                    {s.occurrences}
                    {s.gaps > 0 && <span className="badge badge-warn" title="Some events were dropped because the offline spool was full">gaps</span>}
                  </td>
                  <td className="muted">{s.runtime || '—'}</td>
                  <td>{ago(s.lastSeenAt)}</td>
                  <td>{s.live && <span className="live live-on">● live</span>}</td>
                  <td>
                    <Link className="button" to={`${base}/sessions/${s.id}`} onClick={() => { onSource({ kind: 'cloud' }); onClose(); }}>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="recordings-section">
        <h4>Open a local recording</h4>
        <p className="muted">A JSON export from <code>recorder.export()</code>. You can also drop the file on this window.</p>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void open(f);
            e.target.value = '';
          }}
        />
        <button onClick={() => { setFileError(null); fileInput.current?.click(); }}>Open file…</button>
        {source.kind === 'file' && <span className="muted recordings-current">Showing <code>{source.name}</code></span>}
        {fileError && <p className="form-error" role="alert">{fileError}</p>}
      </section>
    </dialog>
  );
}

/** A button beside the graph settings cog that opens the recordings dialog. */
export function RecordingsButton(props: SourceProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="graph-actions-label" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        Recordings
      </button>
      {open && <RecordingsDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
