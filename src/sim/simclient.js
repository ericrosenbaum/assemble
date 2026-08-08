// Main-thread proxy for the simulation worker.
//
// Presents the same read surface the renderer and analysis HUD already use
// (outlines(), chargeWorld(), params, stepCount, instances, specs), backed by
// the most recent snapshot, so src/render/draw.js works unchanged whether the
// sim runs in a worker or in-thread.

import { MoleculeSpec } from '../shapes.js';

export class WorkerSim {
  constructor() {
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.kind = 'worker';
    this.params = { kT: 0 };
    this.stepCount = 0;
    this.stepsPerSec = 0;
    this.stats = null;
    this.ready = null;
    this._outlines = [];
    this._sites = { x: null, y: null, q: null, mol: null, count: 0, nMol: 0 };
    this._onSnapshot = null;
    this.worker.onmessage = (ev) => this._handle(ev.data);
  }

  init(cfg) {
    this.ready = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.worker.postMessage({ type: 'init', ...cfg });
    return this.ready;
  }

  _handle(msg) {
    if (msg.type === 'ready') {
      this.box = msg.box;
      this.specs = msg.specs.map((s) => MoleculeSpec.fromJSON(s));
      this.instances = msg.instanceSpec.map((spec) => ({ spec }));
      this.backendName = msg.backendName;
      this._vertCounts = msg.vertCounts;
      this._sites.q = msg.chargeQ;
      this._sites.mol = msg.chargeMol;
      this._sites.count = msg.chargeQ.length;
      this._sites.nMol = msg.molecules;
      // Allocate now so the renderer can draw before the first snapshot lands
      // (init resolves on 'ready', which precedes the first 'snapshot').
      this._sites.x = new Float32Array(this._sites.count);
      this._sites.y = new Float32Array(this._sites.count);
      // preallocate the per-molecule outline arrays once
      this._outlines = [];
      for (const n of this._vertCounts) {
        this._outlines.push(Array.from({ length: n }, () => [0, 0]));
      }
      this._resolveReady?.(this);
      return;
    }
    if (msg.type === 'snapshot') {
      // unpack into the preallocated structures
      const oxy = msg.outlineXY;
      let k = 0;
      for (let m = 0; m < this._outlines.length; m++) {
        const poly = this._outlines[m];
        for (let v = 0; v < poly.length; v++) {
          poly[v][0] = oxy[k++];
          poly[v][1] = oxy[k++];
        }
      }
      const cxy = msg.chargeXY;
      const n = this._sites.count;
      for (let i = 0, j = 0; i < n; i++) {
        this._sites.x[i] = cxy[j++];
        this._sites.y[i] = cxy[j++];
      }
      this.stepCount = msg.step;
      this.params.kT = msg.kT;
      this.stepsPerSec = msg.stepsPerSec;
      if (msg.stats) this.stats = msg.stats;

      // hand the buffers straight back so the worker can refill them
      this.worker.postMessage({ type: 'recycle', outlineXY: oxy, chargeXY: cxy }, [
        oxy.buffer,
        cxy.buffer,
      ]);
      this._onSnapshot?.();
    }
  }

  onSnapshot(fn) {
    this._onSnapshot = fn;
  }

  outlines() {
    return this._outlines;
  }

  chargeWorld() {
    return this._sites;
  }

  run() {
    this.worker.postMessage({ type: 'run' });
  }

  pause() {
    this.worker.postMessage({ type: 'pause' });
  }

  setMaxSpeed(value) {
    this.worker.postMessage({ type: 'maxSpeed', value });
  }

  setParams(params, { clearSchedule = false } = {}) {
    Object.assign(this.params, params);
    this.worker.postMessage({ type: 'params', params, clearSchedule });
  }

  anneal(schedule) {
    this.worker.postMessage({ type: 'anneal', schedule });
  }

  free() {
    this.worker.terminate();
  }
}
