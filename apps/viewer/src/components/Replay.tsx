import { useEffect, type ReactNode } from 'react';
import { usePlayback } from '../hooks';
import { occurrenceOfSelection, useStore } from '../store';
import { GraphView } from './GraphView';
import { Inspector } from './Inspector';
import { InspectorToggle } from './InspectorToggle';
import { Timeline } from './Timeline';
import { TraceBar } from './TraceBar';

/** The graph, inspector and timeline for whatever recording the store holds; `empty` shows until there is one. */
export function Replay({ empty, corner, actions, exit }: {
  empty: ReactNode;
  /** Shown in the graph's top-left corner, also while waiting for events. */
  corner?: ReactNode;
  /** Extra buttons shown left of the graph settings cog. */
  actions?: ReactNode;
  /** Shown at the right end of the timeline's play controls. */
  exit?: ReactNode;
}) {
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
      if (e.key.toLowerCase() === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const { index, selection, startTrace } = useStore.getState();
        const id = occurrenceOfSelection(index, selection);
        if (id) startTrace(id);
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
            <div className="canvas">{corner}<GraphView actions={actions} /><TraceBar /></div>
            <div className="inspector-wrap">
              <InspectorToggle />
              {inspectorOpen && <Inspector />}
            </div>
          </div>
          <Timeline exit={exit} />
        </>
      ) : <div className="canvas empty-canvas">{corner}{empty}</div>}
    </>
  );
}
