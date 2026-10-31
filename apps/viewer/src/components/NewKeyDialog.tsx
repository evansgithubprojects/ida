import { useEffect, useRef, useState } from 'react';

/** Shows a just-created ingest key once. It can only be closed with the button, so it isn't lost by a stray Escape or click. */
export function NewKeyDialog({ secret, onClose }: { secret: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false); // The key is selectable text; copying by hand still works.
    }
  };

  return (
    <dialog ref={ref} className="modal" aria-labelledby="new-key-title" onCancel={(e) => e.preventDefault()}>
      <h3 id="new-key-title">Copy your ingest key</h3>
      <p>This is the only time it is shown. Store it somewhere safe, for example as <code>EDA_PROJECT_KEY</code>.</p>
      <code className="secret block">{secret}</code>
      <div className="modal-actions">
        <button onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy'}</button>
        <button className="primary" onClick={onClose}>{copied ? 'Done' : "I've saved it"}</button>
      </div>
    </dialog>
  );
}
