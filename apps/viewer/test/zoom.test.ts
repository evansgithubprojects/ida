import { describe, expect, it } from 'vitest';
import { centreViewport, FIT_MARGIN, fitViewport, MAX_FIT_ZOOM, MIN_ZOOM, rectOnScreen, viewportForRect, zoomFrames } from '../src/graph/zoom';

/** Parses "translate(Xpx, Ypx) scale(S)". */
function parse(transform: string) {
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(transform)!;
  return { tx: Number(m[1]), ty: Number(m[2]), s: Number(m[3]) };
}

describe('zoom helpers', () => {
  it('centres the midpoint of the points in the pane', () => {
    const size = { width: 800, height: 600 };
    const vp = centreViewport([{ x: 100, y: 100 }, { x: 300, y: 200 }], 2, size);
    // The midpoint (200, 150) lands at the pane centre.
    expect({ x: 200 * vp.zoom + vp.x, y: 150 * vp.zoom + vp.y }).toEqual({ x: 400, y: 300 });
    expect(vp.zoom).toBe(2);
  });

  it('maps a flow rectangle into a screen rectangle, centred and fully visible', () => {
    const flow = { x: -100, y: -100, width: 200, height: 200 };
    const screen = { x: 300, y: 50, width: 176, height: 58 };
    const landed = rectOnScreen(flow, viewportForRect(flow, screen));
    expect(landed.height).toBeCloseTo(58);
    expect(landed.x + landed.width / 2).toBeCloseTo(screen.x + screen.width / 2);
    expect(landed.y + landed.height / 2).toBeCloseTo(screen.y + screen.height / 2);
    expect(landed.width).toBeLessThanOrEqual(screen.width);
  });

  it('is exact when the aspect ratios match', () => {
    const flow = { x: 10, y: 20, width: 40, height: 20 };
    const screen = { x: 5, y: 7, width: 400, height: 200 };
    const landed = rectOnScreen(flow, viewportForRect(flow, screen));
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(landed[k]).toBeCloseTo(screen[k]);
  });

  it('shrinks a graph bigger than the pane until it fits, centred', () => {
    const bounds = { x: -600, y: -600, width: 1200, height: 1200 };
    const vp = fitViewport(bounds, 1000, 800);
    const landed = rectOnScreen(bounds, vp);
    expect(landed.x + landed.width / 2).toBeCloseTo(500);
    expect(landed.y + landed.height / 2).toBeCloseTo(400);
    expect(landed.height).toBeCloseTo(800 - 2 * FIT_MARGIN);
    expect(fitViewport({ x: 0, y: 0, width: 1e6, height: 1e6 }, 1000, 800).zoom).toBe(MIN_ZOOM);
  });

  it('shows a small graph at natural size in the middle instead of enlarging it to fill the pane', () => {
    const bounds = { x: 100, y: 50, width: 300, height: 200 };
    const vp = fitViewport(bounds, 1000, 800);
    expect(vp.zoom).toBe(MAX_FIT_ZOOM);
    const landed = rectOnScreen(bounds, vp);
    expect(landed.width).toBeCloseTo(300);
    expect(landed.x + landed.width / 2).toBeCloseTo(500);
    expect(landed.y + landed.height / 2).toBeCloseTo(400);
  });
});

describe('zoomFrames', () => {
  const pane = { width: 900, height: 600 };
  const focus = { x: 100, y: 80, width: 176, height: 58 };
  const f = zoomFrames(focus, pane);
  const at = (frames: typeof f.parent, i: number) => parse(frames[i]!.transform);

  it('starts with the child exactly inside the focus card and the parent untouched', () => {
    const c = at(f.child, 0);
    // The pane's corners land inside the card.
    const left = c.s * 0 + c.tx;
    const right = c.s * pane.width + c.tx;
    const top = c.ty;
    const bottom = c.s * pane.height + c.ty;
    expect(left).toBeGreaterThanOrEqual(focus.x - 1e-6);
    expect(right).toBeLessThanOrEqual(focus.x + focus.width + 1e-6);
    expect(top).toBeGreaterThanOrEqual(focus.y - 1e-6);
    expect(bottom).toBeLessThanOrEqual(focus.y + focus.height + 1e-6);
    // ...centred on it.
    expect((left + right) / 2).toBeCloseTo(focus.x + focus.width / 2);
    expect((top + bottom) / 2).toBeCloseTo(focus.y + focus.height / 2);
    expect(at(f.parent, 0)).toEqual({ tx: 0, ty: 0, s: 1 });
    expect(f.parent[0]!.opacity).toBe(1);
    expect(f.child[0]!.opacity).toBe(0);
  });

  it('ends with the child untransformed and the focus card covering the pane', () => {
    const last = f.child.length - 1;
    const c = at(f.child, last);
    expect(c.s).toBeCloseTo(1);
    expect(c.tx).toBeCloseTo(0);
    expect(c.ty).toBeCloseTo(0);
    expect(f.child[last]!.opacity).toBe(1);
    expect(f.parent[last]!.opacity).toBe(0);
    const p = at(f.parent, last);
    // The card's centre ends up at the pane's centre, and it covers the pane, touching it in the tighter dimension.
    const centre = { x: p.s * (focus.x + focus.width / 2) + p.tx, y: p.s * (focus.y + focus.height / 2) + p.ty };
    expect(centre.x).toBeCloseTo(pane.width / 2);
    expect(centre.y).toBeCloseTo(pane.height / 2);
    expect(Math.min(p.s * focus.width / pane.width, p.s * focus.height / pane.height)).toBeCloseTo(1);
  });

  it('keeps the child centred on the card as both layers move', () => {
    for (let i = 0; i < f.parent.length; i++) {
      const p = at(f.parent, i);
      const c = at(f.child, i);
      const cardCentre = { x: p.s * (focus.x + focus.width / 2) + p.tx, y: p.s * (focus.y + focus.height / 2) + p.ty };
      const paneCentre = { x: c.s * (pane.width / 2) + c.tx, y: c.s * (pane.height / 2) + c.ty };
      expect(paneCentre.x).toBeCloseTo(cardCentre.x);
      expect(paneCentre.y).toBeCloseTo(cardCentre.y);
    }
  });
});
