import { useEffect, useRef, useState } from 'react';
import { api } from '../cloud/api';
import { LANGUAGES, SetupSnippet, type Language } from './SetupSnippet';

/**
 * Connects an app to a project in two screens: create an ingest key, then add it to the app. `startAt: 'setup'`
 * skips the first screen (reopening it later); the new key's secret only exists while the dialog is open.
 */
export function ConnectDialog({ projectId, startAt, onClose, onKeyCreated }: {
  projectId: string;
  startAt: 'key' | 'setup';
  onClose: () => void;
  onKeyCreated: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const setupHeading = useRef<HTMLHeadingElement>(null);
  const [screen, setScreen] = useState<'key' | 'setup'>(startAt);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [language, setLanguage] = useState<Language>('node');
  // The secret is shown once, so Escape must not lose it; Done closes.
  const locked = screen === 'setup' && !!secret;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => {
    if (screen === 'setup' && startAt === 'key') setupHeading.current?.focus();
  }, [screen, startAt]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const k = await api.createKey(projectId, label.trim());
      setSecret(k.key);
      onKeyCreated();
      setScreen('setup');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret ?? '');
      setCopied(true);
    } catch {
      setCopied(false); // The key is selectable text; copying by hand still works.
    }
  };

  return (
    <dialog ref={ref} className="modal connect-modal" aria-label="Connect your app"
      onCancel={(e) => { e.preventDefault(); if (!locked) onClose(); }}>
      {!locked && <button className="icon modal-close" aria-label="Close" onClick={onClose}>×</button>}
      <div className="wizard">
        <div className="wizard-track" style={{ transform: startAt === 'key' && screen === 'setup' ? 'translateX(-100%)' : undefined }}>
          {startAt === 'key' && (
            <form className="wizard-screen form" onSubmit={create} inert={screen !== 'key'}>
              <h3>Create an ingest key</h3>
              <p className="muted">Your app uses a key to upload its events to this project. Keys can only upload data, and you can revoke one at any time.</p>
              <label>Label (optional)
                <input placeholder="e.g. staging" maxLength={100} value={label} onChange={(e) => setLabel(e.target.value)} disabled={busy} />
              </label>
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="modal-actions split">
                <button type="button" className="link skip" onClick={onClose} disabled={busy}>Skip for now</button>
                <button className="primary" disabled={busy} aria-busy={busy} aria-label={busy ? 'Creating key' : undefined}>
                  {busy ? <span className="spinner" aria-hidden="true" /> : 'Create key'}
                </button>
              </div>
            </form>
          )}
          <div className="wizard-screen" inert={screen !== 'setup'}>
            <h3 ref={setupHeading} tabIndex={-1}>{startAt === 'key' ? 'Add it to your app' : 'Connect your app'}</h3>
            {secret && (
              <>
                <div className="key-row">
                  <code className="secret block">{secret}</code>
                  <button onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy'}</button>
                </div>
                <p className="hint">Shown only once. Copy it now and keep it somewhere safe, for example as <code>IDA_PROJECT_KEY</code>.</p>
              </>
            )}
            <label className="lang-select">Language
              <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
                {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </label>
            <SetupSnippet language={language} projectKey={secret} />
            <div className="modal-actions">
              <button className="primary" onClick={onClose}>Done</button>
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
