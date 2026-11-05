import {
  BaseEdge, Controls, EdgeLabelRenderer, Handle, Position, ReactFlow, ReactFlowProvider, useInternalNode, useReactFlow,
  type Edge, type EdgeProps, type InternalNode, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { layout, layoutBounds, NODE_H, NODE_W, type Positions } from '../graph/layout';
import { processNodeId, type Level, type ModelEdge, type ModelNode } from '../graph/model';
import {
  centreViewport, fitViewport, MAX_ZOOM, saveViewport, takeSavedViewport, MIN_ZOOM, motion, rectOnScreen, toKeyframes, ZOOM_MS, zoomFrames, type Rect, type Viewport,
} from '../graph/zoom';
import { useActive, useModel } from '../hooks';
import { countFired, type Active } from '../replay';
import { useStore } from '../store';
import { NodeRef } from './common';

/**
 * Everything that changes while replaying lives in this context, not in the node/edge objects handed to
 * React Flow. Replacing those objects makes React Flow hide every node for a frame while it re-measures,
 * which flickers during playback and swallows clicks.
 */
interface ViewState {
  nodes: Map<string, ModelNode>;
  edges: Map<string, ModelEdge>;
  active: Active;
  selectedId: string | null;
  /** Briefly set after a "show on graph" request. */
  focusedId: string | null;
  focusedEdgeId: string | null;
  /** Playhead and the end of the replay window, for the pathway counters. */
  t: number;
  end: number;
}

const ViewCtx = createContext<ViewState | null>(null);
const useView = () => useContext(ViewCtx)!;

type RouteNode = Node<Record<string, never>, 'route'>;
type RingNode = Node<{ label: string; size: number }, 'ring'>;
type AnyNode = RouteNode | RingNode;
type RouteEdge = Edge<Record<string, never>, 'route'>;

const RING_ID = '__ring';
const hiddenHandle = { opacity: 0, pointerEvents: 'none' } as const;

const NodeCard = memo(function NodeCard({ id }: NodeProps<RouteNode>) {
  const { nodes, active, selectedId, focusedId } = useView();
  const model = nodes.get(id);
  if (!model) return null;
  const flashing = active.flashingNodes.has(id);
  const thrown = active.thrownNodes.get(id) ?? 0;
  const cls = ['node-card', `kind-${model.kind}`, flashing && 'flash', thrown > 0 && 'has-thrown', model.idle && 'idle', selectedId === id && 'selected', focusedId === id && 'focused'];
  return (
    <div className={cls.filter(Boolean).join(' ')} style={{ width: NODE_W, height: NODE_H }}>
      <Handle type="target" position={Position.Left} isConnectable={false} style={hiddenHandle} />
      <div className="node-title" title={model.label}>{model.kind === 'process' || model.kind === 'stub' ? model.label : <NodeRef id={model.id} label={model.label} qualify={false} />}</div>
      <div className="node-detail">{model.detail}</div>
      {thrown > 0 && <span className="corner corner-error" title={`${thrown} throw(s) so far`}>✕ {thrown}</span>}
      <Handle type="source" position={Position.Right} isConnectable={false} style={hiddenHandle} />
    </div>
  );
});

/** The process being looked into, drawn as a big circle behind its handlers. */
const RingNodeView = memo(function RingNodeView({ data }: NodeProps<RingNode>) {
  return (
    <div className="ring-node" style={{ width: data.size, height: data.size }}>
      <span>{data.label}</span>
    </div>
  );
});

/** How far a pathway runs under the card it ends at, so no sliver shows at an angled border or a rounded corner. */
const EDGE_TUCK = 10;

/**
 * Where the line between two node centres leaves a `w` x `h` card centred at (cx, cy), moved `tuck` px back inside
 * the card. Cards are opaque and drawn over pathways, so the tucked part is hidden.
 */
function edgePoint(cx: number, cy: number, w: number, h: number, tx: number, ty: number, tuck = 0): [number, number] {
  const dx = tx - cx;
  const dy = ty - cy;
  const scale = 1 / Math.max(Math.abs(dx) / (w / 2) || 0, Math.abs(dy) / (h / 2) || 0, 1e-6);
  const len = Math.hypot(dx, dy) || 1;
  return [cx + dx * scale - (dx / len) * tuck, cy + dy * scale - (dy / len) * tuck];
}

const centreOf = (n: InternalNode) => {
  const w = n.measured.width ?? NODE_W;
  const h = n.measured.height ?? NODE_H;
  return { cx: n.internals.positionAbsolute.x + w / 2, cy: n.internals.positionAbsolute.y + h / 2, w, h };
};

/**
 * Straight between card borders, bowed a little to one side. The bow flips with the direction, so A→B and
 * B→A don't lie on top of each other.
 */
function floatingPath(source: InternalNode, target: InternalNode): [string, number, number] {
  const s = centreOf(source);
  const t = centreOf(target);
  // Cards that nearly touch would tuck the whole line away.
  const tuck = Math.min(EDGE_TUCK, Math.hypot(t.cx - s.cx, t.cy - s.cy) / 8);
  const [sx, sy] = edgePoint(s.cx, s.cy, s.w, s.h, t.cx, t.cy, tuck);
  const [tx, ty] = edgePoint(t.cx, t.cy, t.w, t.h, s.cx, s.cy, tuck);
  const dx = tx - sx;
  const dy = ty - sy;
  const len = Math.hypot(dx, dy) || 1;
  const bow = len * 0.18;
  const qx = (sx + tx) / 2 - (dy / len) * bow;
  const qy = (sy + ty) / 2 + (dx / len) * bow;
  return [`M ${sx} ${sy} Q ${qx} ${qy} ${tx} ${ty}`, 0.25 * sx + 0.5 * qx + 0.25 * tx, 0.25 * sy + 0.5 * qy + 0.25 * ty];
}

/** How much of a line the travelling pulse covers. */
const PULSE_LENGTH = 0.2;

const RouteEdgeView = memo(function RouteEdgeView({ id, source, target }: EdgeProps<RouteEdge>) {
  const { edges, active, selectedId, focusedEdgeId, t, end } = useView();
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  const edge = edges.get(id);
  if (!edge || !from || !to) return null;
  const [path, lx, ly] = floatingPath(from, to);
  const flagged = active.flaggedEdges.get(id);
  const litFlagged = active.litFlaggedEdges.has(id);
  // Lines stay dim and still; a lit one only means an event is on it right now, drawn as a pulse that travels from sender to receiver.
  const pulseColor = litFlagged ? 'var(--warn)' : 'var(--accent)';
  // Thickness follows the total so lines don't change width while the counter ticks.
  const width = 1.5 + Math.min(3, Math.log2(edge.count + 1) * 0.5);
  // Every event still on its way gets its own pulse, so a busy route shows them all instead of restarting one.
  const flights = active.pulses.get(id) ?? [];
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={focusedEdgeId === id ? 'edge-focused' : undefined}
        style={{
          stroke: flagged ? 'var(--warn-dim)' : 'var(--edge)', strokeWidth: width, opacity: 0.75,
          strokeDasharray: flagged ? '7 5' : undefined,
        }}
      />
      {flights.map((progress, i) => (
        <path
          key={i}
          d={path} pathLength={1} fill="none" stroke={pulseColor} strokeWidth={width + 1.5} strokeLinecap="round"
          strokeDasharray={`${PULSE_LENGTH} 2`} strokeDashoffset={PULSE_LENGTH - progress * (1 + PULSE_LENGTH)}
          style={{ pointerEvents: 'none', filter: `drop-shadow(0 0 5px ${pulseColor})` }}
        />
      ))}
      <EdgeLabelRenderer>
        <div className={`edge-label ${selectedId === id ? 'selected' : ''} ${focusedEdgeId === id ? 'focused' : ''}`} style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>
          <span title={`${edge.count} in this window`}>{countFired(edge.times, t, end)}</span>
          {flagged && <span className="mark mark-warn" title={`Suspected corrupt payloads on this route${flagged.high ? ', some reaching an external system' : ''}`}>⚠{flagged.count}</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

const nodeTypes = { route: NodeCard, ring: RingNodeView };
const edgeTypes = { route: RouteEdgeView };

const boxOf = (p: { x: number; y: number }): Rect => ({ x: p.x, y: p.y, width: NODE_W, height: NODE_H });
const sameLevel = (a: Level, b: Level) => a.kind === b.kind && (a.kind === 'process' || (b.kind === 'handlers' && a.processId === b.processId));

/** What a transition needs to know about a mounted layer: where its nodes are and where the camera is. */
interface Geometry {
  positions: Positions;
  viewport: () => Viewport;
}

interface Size { width: number; height: number }

interface LayerProps {
  layerKey: number;
  level: Level;
  size: Size;
  geometry: Map<number, Geometry>;
  /** Re-fit the camera when the graph's shape changes (only for the layer on top, not during a zoom). */
  refit: boolean;
}

/** One zoom level of the graph. A layer keeps its own level, so the outgoing one stays put while it fades. */
function GraphLayer({ layerKey, level, size, geometry, refit }: LayerProps) {
  const model = useModel(level);
  const active = useActive(model);
  const index = useStore((s) => s.index);
  const t = useStore((s) => s.t);
  const end = useStore((s) => s.window[1]);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const focus = useStore((s) => s.focus);
  const setLevel = useStore((s) => s.setLevel);
  const { setViewport, getViewport } = useReactFlow<AnyNode, RouteEdge>();

  // Re-layout only when the shape of the graph changes, not on every count update.
  const sig = useMemo(
    () => (model ? level.kind + '|' + model.nodes.map((n) => n.id).sort().join(',') + '|' + model.edges.map((e) => e.id).sort().join(',') : ''),
    [model, level.kind],
  );
  const lay = useMemo(
    () => (model ? layout(model, level.kind === 'handlers') : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig],
  );

  // The camera is ours to place, so a transition can compute where every node is on screen without measuring.
  // After a reload the camera goes back where it was; otherwise the whole graph is fitted.
  const [initialViewport] = useState<Viewport>(() => (lay ? takeSavedViewport(sig) ?? fitViewport(layoutBounds(lay), size.width, size.height) : { x: 0, y: 0, zoom: 1 }));
  const camera = useRef<Viewport>(initialViewport);
  useLayoutEffect(() => {
    if (!lay) return;
    geometry.set(layerKey, { positions: lay.positions, viewport: () => camera.current });
    return () => { geometry.delete(layerKey); };
  }, [lay, geometry, layerKey]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!lay || !refit) return;
    camera.current = takeSavedViewport(sig) ?? fitViewport(layoutBounds(lay), size.width, size.height);
    void setViewport(camera.current, { duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // Only the layer on top answers focus requests, and not mid-zoom: a request that zoomed in lands once it's done.
  const focusedId = focus?.nodeId && refit && model ? (model.nodes.some((n) => n.id === focus.nodeId) ? focus.nodeId : model.mapNode(focus.nodeId)) : null;
  const focusedEdge = focus?.edgeId && refit ? model?.edges.find((e) => e.id === focus.edgeId) : undefined;
  // A re-fit (the graph's shape changed) puts the camera back on the whole graph, so the pan is applied again after it.
  const panned = useRef('');
  useEffect(() => {
    // A pathway is centred on the midpoint between its ends.
    const ends = focusedEdge ? [focusedEdge.source, focusedEdge.target] : focusedId ? [focusedId] : [];
    const ps = ends.map((id) => lay?.positions.get(id));
    if (!focus || !ps.length || ps.some((p) => !p)) return;
    const key = `${focus.seq}|${sig}`;
    if (panned.current === key) return;
    panned.current = key;
    camera.current = centreViewport(ps.map((p) => ({ x: p!.x + NODE_W / 2, y: p!.y + NODE_H / 2 })), Math.max(getViewport().zoom, 1), size);
    void setViewport(camera.current, { duration: motion(400) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq, refit, sig]);

  // Stable objects: only a new layout produces new ones.
  const nodes = useMemo<AnyNode[]>(() => {
    if (!model || !lay) return [];
    const list: AnyNode[] = [];
    if (lay.ring && level.kind === 'handlers') {
      const r = lay.ring.radius;
      list.push({
        id: RING_ID, type: 'ring', position: { x: -r, y: -r }, width: 2 * r, height: 2 * r, zIndex: -1,
        data: { label: index?.processLabel.get(level.processId) ?? level.processId, size: 2 * r },
        draggable: false, selectable: false, focusable: false,
      });
    }
    for (const m of model.nodes) {
      list.push({ id: m.id, type: 'route', position: lay.positions.get(m.id) ?? { x: 0, y: 0 }, data: {}, width: NODE_W, height: NODE_H });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lay]);

  const edges = useMemo<RouteEdge[]>(
    () => (model ? model.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, type: 'route', data: {} })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sig],
  );

  const view = useMemo<ViewState | null>(
    () => (model && active ? {
      nodes: new Map(model.nodes.map((n) => [n.id, n])), edges: new Map(model.edges.map((e) => [e.id, e])), active,
      selectedId: selection && selection.type !== 'occurrence' && selection.type !== 'event' ? selection.id : null,
      focusedId, focusedEdgeId: focusedEdge?.id ?? null, t, end,
    } : null),
    [model, active, selection, focusedId, focusedEdge, t, end],
  );

  if (!model || !view || !lay) return null;
  if (!model.nodes.length) return <div className="empty">Nothing recorded in this window.</div>;

  return (
    <ViewCtx.Provider value={view}>
      <ReactFlow<AnyNode, RouteEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode="dark"
        defaultViewport={initialViewport}
        onMoveEnd={(_, vp) => { camera.current = vp; if (refit) saveViewport(sig, vp); }}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        zoomOnDoubleClick={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => n.id !== RING_ID && select({ type: 'node', id: n.id }, { fromGraph: true })}
        onEdgeClick={(_, e) => select({ type: 'edge', id: e.id }, { fromGraph: true })}
        onPaneClick={() => select(null)}
        onNodeDoubleClick={(_, n) => {
          const m = model.nodes.find((x) => x.id === n.id);
          if (!m) return;
          if (m.kind === 'process' || m.kind === 'stub') setLevel({ kind: 'handlers', processId: m.processId });
        }}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
    </ViewCtx.Provider>
  );
}

interface Layer { key: number; level: Level }
interface Layers { current: Layer; outgoing: Layer | null }

/** Where the graph is zoomed to, centred along its top edge. */
function ZoomCrumbs() {
  const index = useStore((s) => s.index);
  const level = useStore((s) => s.level);
  const setLevel = useStore((s) => s.setLevel);
  const processLabel = level.kind === 'handlers' ? index?.processLabel.get(level.processId) : undefined;
  return (
    <nav className="crumbs zoom-crumbs" aria-label="Zoom level">
      <button className={level.kind === 'process' ? 'current' : ''} onClick={() => setLevel({ kind: 'process' })}>Processes</button>
      {processLabel && (
        <>
          <span>›</span>
          <button className="current">{processLabel}</button>
        </>
      )}
    </nav>
  );
}

/**
 * Zooming is a crossfade between two stacked layers driven by one camera: the parent grows around the card
 * being entered and fades away, uncovering the child, which starts small inside that card. Going back plays
 * the same thing in reverse. Only CSS transforms and opacity animate, so React Flow never re-renders mid-zoom.
 */
export function GraphView() {
  const level = useStore((s) => s.level);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size | null>(null);
  const keys = useRef(0);
  const [layers, setLayers] = useState<Layers>(() => ({ current: { key: 0, level }, outgoing: null }));
  const geometry = useRef(new Map<number, Geometry>()).current;
  const wrappers = useRef(new Map<number, HTMLDivElement>()).current;
  const running = useRef<Animation[]>([]);

  // Any change of level, from any control, starts a transition.
  if (!sameLevel(layers.current.level, level)) {
    setLayers({ current: { key: ++keys.current, level }, outgoing: layers.current });
  }

  useLayoutEffect(() => {
    const el = box.current!;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((prev) => (prev && prev.width === r.width && prev.height === r.height ? prev : { width: r.width, height: r.height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { current, outgoing } = layers;
  const zoomOut = !!outgoing && outgoing.level.kind === 'handlers' && current.level.kind === 'process';

  useLayoutEffect(() => {
    if (!outgoing) return;
    for (const a of running.current) a.cancel();
    running.current = [];
    const done = () => setLayers((l) => (l.outgoing?.key === outgoing.key ? { ...l, outgoing: null } : l));
    const incoming = wrappers.get(current.key);
    const leaving = wrappers.get(outgoing.key);
    const ms = motion(ZOOM_MS);
    if (!incoming || !leaving || !size || ms === 0) { done(); return; }

    // The parent is the layer holding the card that gets zoomed into: the old one going in, the new one coming out.
    const parent = zoomOut ? current : outgoing;
    const child = zoomOut ? outgoing : current;
    const focusLevel = child.level;
    const focusId = focusLevel.kind === 'handlers' ? processNodeId(focusLevel.processId) : null;
    const g = geometry.get(parent.key);
    const p = focusId ? g?.positions.get(focusId) : undefined;

    const options: KeyframeAnimationOptions = { duration: ms, fill: 'both', easing: 'linear' };
    let anims: Animation[];
    let kept: Animation; // the animation on the layer that stays
    if (!g || !p) {
      // Nothing to zoom into (e.g. a process that isn't a neighbour): just crossfade.
      anims = [
        leaving.animate([{ opacity: 1 }, { opacity: 0 }], options),
        incoming.animate([{ opacity: 0 }, { opacity: 1 }], options),
      ];
      kept = anims[1]!;
    } else {
      const frames = zoomFrames(rectOnScreen(boxOf(p), g.viewport()), size);
      const direction = zoomOut ? 'reverse' : 'normal';
      anims = [
        wrappers.get(parent.key)!.animate(toKeyframes(frames.parent), { ...options, direction }),
        wrappers.get(child.key)!.animate(toKeyframes(frames.child), { ...options, direction }),
      ];
      kept = zoomOut ? anims[0]! : anims[1]!;
    }
    running.current = anims;
    Promise.all(anims.map((a) => a.finished)).then(
      () => {
        if (running.current !== anims) return;
        running.current = [];
        // The finished state of the layer that stays is the plain one, so dropping its animation changes nothing.
        kept.cancel();
        done();
      },
      () => { /* cancelled by a newer transition */ },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.key]);

  const transitioning = outgoing !== null;
  return (
    <div ref={box} className="graph-stack">
      <ZoomCrumbs />
      {size && [current, outgoing].map((layer) => layer && (
        <div
          key={layer.key}
          ref={(el) => { if (el) wrappers.set(layer.key, el); else wrappers.delete(layer.key); }}
          className={`graph-layer ${transitioning ? 'animating' : ''}`}
          style={{ zIndex: !transitioning ? 1 : (layer === outgoing) !== zoomOut ? 2 : 1 }}
        >
          <ReactFlowProvider>
            <GraphLayer
              layerKey={layer.key}
              level={layer.level}
              size={size}
              geometry={geometry}
              refit={!transitioning}
            />
          </ReactFlowProvider>
        </div>
      ))}
    </div>
  );
}
