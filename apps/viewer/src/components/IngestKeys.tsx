import { useState } from 'react';
import { api } from '../cloud/api';
import { maskKey } from '../cloud/keys';
import { ago, useApi } from '../cloud/useApi';
import { NewKeyDialog } from './NewKeyDialog';

/** The project's ingest keys: create one (shown once in a dialog) and revoke. Listed keys are masked. */
export function IngestKeys({ projectId, onError }: { projectId: string; onError: (message: string | null) => void }) {
  const keys = useApi(() => api.keys(projectId), [projectId]);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const active = keys.data?.filter((k) => !k.revokedAt) ?? [];

  const act = async (fn: () => Promise<unknown>) => {
    onError(null);
    try { await fn(); } catch (err) { onError((err as Error).message); }
  };

  return (
    <>
      {fresh && <NewKeyDialog secret={fresh} onClose={() => setFresh(null)} />}
      <p className="muted">Keys can only upload data. Revoke one if it leaks; apps using it stop uploading.</p>
      {active.length > 0 ? (
        <table className="table">
          <thead><tr><th>Key</th><th>Label</th><th>Created</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {active.map((k) => (
              <tr key={k.id}>
                <td><code>{maskKey(k.prefix)}</code></td>
                <td>{k.label || <span className="muted">—</span>}</td>
                <td>{ago(k.createdAt)}</td>
                <td>{ago(k.lastUsedAt)}</td>
                <td>
                  <button onClick={() => window.confirm(`Revoke ${k.prefix}…? Apps using it stop uploading.`) && act(async () => { await api.revokeKey(projectId, k.id); keys.reload(); })}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : keys.data && <p className="muted">No keys yet.</p>}
      <form className="form inline" onSubmit={(e) => { e.preventDefault(); void act(async () => { const k = await api.createKey(projectId, label); setFresh(k.key); setLabel(''); keys.reload(); }); }}>
        <input placeholder="Label (optional), e.g. staging" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Key label" />
        <button className="primary">New key</button>
      </form>
    </>
  );
}
