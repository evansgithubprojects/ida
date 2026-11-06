import type { RecorderSummary } from './api';

const keyFor = (projectId: string) => `ida_last_recorder:${projectId}`;

/** Remembers the recorder last opened in the viewer for a project, so "Open viewer" goes back to it. */
export function rememberRecorder(projectId: string, recorderKey: string): void {
  try { localStorage.setItem(keyFor(projectId), recorderKey); } catch { /* storage unavailable: falls back to the newest recorder */ }
}

/**
 * The recorder "Open viewer" opens: the last one opened if it still exists, otherwise the one that sent data most
 * recently. Null when the project has no recorders yet.
 */
export function recorderToOpen(projectId: string, recorders: readonly RecorderSummary[]): string | null {
  let last: string | null = null;
  try { last = localStorage.getItem(keyFor(projectId)); } catch { /* ignore */ }
  if (last && recorders.some((r) => r.key === last)) return last;
  const newest = [...recorders].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0];
  return newest?.key ?? null;
}
