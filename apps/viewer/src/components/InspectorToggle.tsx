import { useStore } from '../store';

/** A tab on the inspector's edge that hides and shows it. It sits on the canvas's edge too when the inspector is closed. */
export function InspectorToggle() {
  const open = useStore((s) => s.inspectorOpen);
  const setOpen = useStore((s) => s.setInspectorOpen);
  const label = open ? 'Hide inspector' : 'Show inspector';
  return (
    <button
      className={`inspector-toggle ${open ? 'open' : 'closed'}`}
      aria-label={label}
      aria-expanded={open}
      aria-controls={open ? 'inspector' : undefined}
      title={`${label} (I)`}
      onClick={() => setOpen(!open)}
    >
      {!open && <span className="inspector-toggle-label">Inspector</span>}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}
