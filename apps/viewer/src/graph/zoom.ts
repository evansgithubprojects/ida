export interface Rect { x: number; y: number; width: number; height: number }
export interface Viewport { x: number; y: number; zoom: number }

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 8;
/**
 * The most a graph is enlarged when it is first shown: natural size. A small graph then sits in the middle of the
 * pane instead of filling it, so how much of the pane a graph takes up tells you how big the project is.
 */
export const MAX_FIT_ZOOM = 1;
export const ZOOM_MS = 700;
/** Pixels left around a freshly shown graph, so the outermost nodes and their markers aren't clipped. */
export const FIT_MARGIN = 24;
const STEPS = 24;

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A duration, or 0 when the user asked for less motion. */
export const motion = (ms: number) => (prefersReducedMotion() ? 0 : ms);

/** The viewport that draws `flow` (flow coordinates) inside `screen` (pane pixels), centred and fully visible. */
export function viewportForRect(flow: Rect, screen: Rect): Viewport {
  const zoom = Math.min(screen.width / flow.width, screen.height / flow.height);
  return {
    zoom,
    x: screen.x + screen.width / 2 - (flow.x + flow.width / 2) * zoom,
    y: screen.y + screen.height / 2 - (flow.y + flow.height / 2) * zoom,
  };
}

/** Where a flow-space rectangle lands on screen under `vp`. */
export function rectOnScreen(flow: Rect, vp: Viewport): Rect {
  return { x: flow.x * vp.zoom + vp.x, y: flow.y * vp.zoom + vp.y, width: flow.width * vp.zoom, height: flow.height * vp.zoom };
}

/** The viewport a graph opens at: zoomed in as far as all of `bounds` still fits, but never past natural size. */
export function fitViewport(bounds: Rect, width: number, height: number, margin = FIT_MARGIN): Viewport {
  const m = Math.min(margin, width / 4, height / 4);
  const inner = viewportForRect(bounds, { x: m, y: m, width: width - 2 * m, height: height - 2 * m });
  const zoom = Math.min(MAX_FIT_ZOOM, Math.max(MIN_ZOOM, inner.zoom));
  return {
    zoom,
    x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

/** The viewport at `zoom` that puts the midpoint of `points` (flow coordinates) in the middle of a `size` pane. */
export function centreViewport(points: { x: number; y: number }[], zoom: number, size: { width: number; height: number }): Viewport {
  const cx = points.reduce((n, p) => n + p.x, 0) / points.length;
  const cy = points.reduce((n, p) => n + p.y, 0) / points.length;
  return { zoom, x: size.width / 2 - cx * zoom, y: size.height / 2 - cy * zoom };
}

const easeInOutCubic = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const smooth = (a: number, b: number, p: number) => {
  const x = Math.min(1, Math.max(0, (p - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

export interface Frame { offset: number; transform: string; opacity: number }

export interface ZoomFrames {
  /** The layer being zoomed into: it grows around `focus` and fades away. */
  parent: Frame[];
  /** The layer underneath: it starts small inside `focus` and grows to fill the pane. */
  child: Frame[];
  /** How far the parent is scaled at the end; the child starts at 1 / scale. */
  scale: number;
}

/**
 * One virtual camera drives both layers. `focus` is the card (in pane pixels) that gets zoomed into. At the
 * start the child layer sits exactly inside it; at the end the child is untransformed and the card fills the
 * pane. Transforms use origin 0 0, so x' = s·x + t. Play it backwards to zoom out.
 */
export function zoomFrames(focus: Rect, pane: { width: number; height: number }): ZoomFrames {
  const ox = focus.x + focus.width / 2;
  const oy = focus.y + focus.height / 2;
  const cx = pane.width / 2;
  const cy = pane.height / 2;
  const k = Math.max(pane.width / focus.width, pane.height / focus.height);
  const parent: Frame[] = [];
  const child: Frame[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const offset = i / STEPS;
    const u = easeInOutCubic(offset);
    const s = Math.pow(k, u);
    const m = s / k;
    parent.push({
      offset,
      transform: `translate(${ox * (1 - s) + (cx - ox) * u}px, ${oy * (1 - s) + (cy - oy) * u}px) scale(${s})`,
      opacity: 1 - smooth(0.15, 0.75, offset),
    });
    child.push({
      offset,
      transform: `translate(${cx * (1 - m) + (ox - cx) * (1 - u)}px, ${cy * (1 - m) + (oy - cy) * (1 - u)}px) scale(${m})`,
      opacity: smooth(0, 0.55, offset),
    });
  }
  return { parent, child, scale: k };
}

export const toKeyframes = (frames: Frame[]): Keyframe[] => frames.map((f) => ({ offset: f.offset, transform: f.transform, opacity: f.opacity }));

const SAVED_KEY = 'eda-debugger:viewport';

/** The camera as it was when the page was last left, read once at load so later saves can't overwrite it first. */
let fromLastLoad: { sig: string; viewport: Viewport } | null = (() => {
  try {
    const raw = sessionStorage.getItem(SAVED_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
})();

/** Remembers where the camera is for the graph `sig`, so a reload can put it back. Per tab. */
export function saveViewport(sig: string, viewport: Viewport): void {
  try {
    sessionStorage.setItem(SAVED_KEY, JSON.stringify({ sig, viewport }));
  } catch {
    /* storage unavailable: a reload just fits the graph */
  }
}

/** The position saved before a reload, once, and only for the same graph; after that every graph opens fitted. */
export function takeSavedViewport(sig: string): Viewport | null {
  if (!fromLastLoad || fromLastLoad.sig !== sig) return null;
  const { viewport } = fromLastLoad;
  fromLastLoad = null;
  return viewport;
}
