import type { GraphNode, Process } from './types';

const GENERIC = new Set(['EventEmitter', 'EventTarget', 'Object', 'Function', '']);

export interface EmitterRef {
  node: GraphNode;
  process: Process;
}

/** Stable ids and labels for emitters (processes) and handlers (nodes). */
export class Registry {
  readonly processes = new Map<string, Process>();
  readonly nodes = new Map<string, GraphNode>();
  private emitters = new WeakMap<object, EmitterRef>();
  private handlers = new WeakMap<Function, GraphNode>();
  private emitterLabels = new WeakMap<object, string>();
  private handlerLabels = new WeakMap<Function, string>();
  private processByLabel = new Map<string, Process>();
  private labelCounts = new Map<string, number>();
  private seq = { em: 0, h: 0, p: 0 };
  private fresh: { nodes: GraphNode[]; processes: Process[] } = { nodes: [], processes: [] };

  labelEmitter(emitter: object, label: string): void { this.emitterLabels.set(emitter, label); }
  labelHandler(fn: Function, label: string): void { this.handlerLabels.set(fn, label); }

  emitter(obj: object, hint?: string): EmitterRef {
    const known = this.emitters.get(obj);
    if (known) return known;
    const base = this.emitterLabels.get(obj) ?? hint ?? (obj as { constructor?: { name?: string } }).constructor?.name ?? '';
    let label = base;
    if (!this.emitterLabels.has(obj) && (!hint || GENERIC.has(base))) {
      const n = (this.labelCounts.get(base || 'Emitter') ?? 0) + 1;
      this.labelCounts.set(base || 'Emitter', n);
      label = `${base || 'Emitter'}#${n}`;
    }
    let process = this.processByLabel.get(label);
    if (!process) {
      process = { id: `p${++this.seq.p}`, label };
      this.processByLabel.set(label, process);
      this.processes.set(process.id, process);
      this.fresh.processes.push(process);
    }
    const node: GraphNode = { id: `em${++this.seq.em}`, processId: process.id, label, kind: 'emitter' };
    this.nodes.set(node.id, node);
    this.fresh.nodes.push(node);
    const ref = { node, process };
    this.emitters.set(obj, ref);
    return ref;
  }

  /** A handler belongs to the process of the first emitter it was seen on. */
  handler(fn: Function, owner: EmitterRef): GraphNode {
    const known = this.handlers.get(fn);
    if (known) return known;
    const id = `h${++this.seq.h}`;
    const node: GraphNode = {
      id, processId: owner.process.id, kind: 'handler',
      label: this.handlerLabels.get(fn) ?? (fn.name || `anonymous#${this.seq.h}`),
    };
    this.handlers.set(fn, node);
    this.nodes.set(id, node);
    this.fresh.nodes.push(node);
    return node;
  }

  /** Nodes and processes created since the last call (for live streaming). */
  drainFresh(): { nodes: GraphNode[]; processes: Process[] } {
    const out = this.fresh;
    this.fresh = { nodes: [], processes: [] };
    return out;
  }
}
