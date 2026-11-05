import { useEffect, type ReactNode } from 'react';
import { usePlayback } from '../hooks';
import { useStore } from '../store';
import { GraphView } from './GraphView';
import { Inspector } from './Inspector';
import { InspectorToggle } from './InspectorToggle';
import { Timeline } from './Timeline';

/** The graph, inspector and timeline for whatever recording the store holds; `empty` shows until there is one. */
export function Replay({ empty }: { empty: ReactNode }) {
  const index = useStore((s) => s.index);
  const inspectorOpen = useStore((s) => s.inspectorOpen);
  usePlayback();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.key.toLowerCase() === 'i' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const { inspectorOpen: open, setInspectorOpen } = useStore.getState();
        setInspectorOpen(!open);
        return;
      }
      if (e.code === 'Space' && useStore.getState().mode === 'replay') { e.preventDefault(); useStore.getState().togglePlay(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {index ? (
        <>
          <div className="main">
            <div className="canvas"><GraphView /></div>
            <div className="inspector-wrap">
              <InspectorToggle />
              {inspectorOpen && <Inspector />}
            </div>
          </div>
          <Timeline />
        </>
      ) : empty}
    </>
  );
}
