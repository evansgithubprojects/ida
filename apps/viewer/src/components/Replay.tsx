import { useEffect, type ReactNode } from 'react';
import { usePlayback } from '../hooks';
import { useStore } from '../store';
import { GraphView } from './GraphView';
import { Inspector } from './Inspector';
import { Timeline } from './Timeline';
import { Toasts } from './Toasts';

/** The graph, inspector and timeline for whatever recording the store holds; `empty` shows until there is one. */
export function Replay({ empty }: { empty: ReactNode }) {
  const index = useStore((s) => s.index);
  usePlayback();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, select, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); useStore.getState().togglePlay(); }
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
            <Inspector />
          </div>
          <Timeline />
        </>
      ) : empty}
      <Toasts />
    </>
  );
}
