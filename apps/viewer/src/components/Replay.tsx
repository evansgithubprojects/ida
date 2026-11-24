import { useEffect, type ReactNode } from 'react';
import { usePlayback } from '../hooks';
import { occurrenceOfSelection, useStore } from '../store';
import { GraphView } from './GraphView';
import { Inspector } from './Inspector';
import { InspectorToggle } from './InspectorToggle';
import { Timeline } from './Timeline';
import { TraceSlideshow } from './TraceSlideshow';

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
  const tracing = useStore((s) => s.trace !== null);
  usePlayback();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      const { trace } = useStore.getState();
      if (trace && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const keys: Record<string, () => void> = {
          ArrowLeft: () => useStore.getState().traceStep(trace.at - 1),
          ArrowRight: () => useStore.getState().traceStep(trace.at + 1),
          Escape: () => useStore.getState().endTrace(),
          Space: () => useStore.getState().setTraceAuto(!trace.auto),
        };
        const run = keys[e.code] ?? keys[e.key];
        if (run) {
          e.preventDefault();
          run();
          return;
        }
      }
      if (e.key.toLowerCase() === 'i' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const { inspectorOpen: open, setInspectorOpen } = useStore.getState();
        setInspectorOpen(!open);
        return;
      }
      if (e.key.toLowerCase() === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const { index, selection, startTrace } = useStore.getState();
        const id = occurrenceOfSelection(index, selection);
        if (selection && id) {
          const type = selection.type === 'throw' || selection.type === 'finding' ? selection.type : 'occurrence';
          startTrace({ type, id: type === 'occurrence' ? id : selection.id, occurrenceId: id });
        }
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
            <div className="canvas">{corner}<GraphView actions={actions} /></div>
            <div className="inspector-wrap">
              <InspectorToggle />
              {inspectorOpen && <Inspector />}
            </div>
          </div>
          {tracing ? <TraceSlideshow exit={exit} /> : <Timeline exit={exit} />}
        </>
      ) : <div className="canvas empty-canvas">{corner}{empty}</div>}
    </>
  );
}
