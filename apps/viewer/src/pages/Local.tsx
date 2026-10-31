import { useState } from 'react';
import { Replay } from '../components/Replay';
import { loadFile, Toolbar } from '../components/Toolbar';

/** Recordings that never touch the server: a dropped JSON export or a local `startBridge` stream. */
export function Local() {
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <div
      className={`app ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) setError(await loadFile(f));
      }}
    >
      <Toolbar onError={setError} />
      {error && <div className="banner" role="alert">{error} <button onClick={() => setError(null)}>Dismiss</button></div>}
      <Replay
        empty={(
          <div className="welcome">
            <h2>Drop a recording here</h2>
            <p>Open a JSON export from <code>recorder.export()</code>, load the sample, or connect to a live stream.</p>
          </div>
        )}
      />
    </div>
  );
}
