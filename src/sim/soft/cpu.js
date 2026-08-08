// Soft-body engine, CPU reference implementation.
//
// Each molecule is built from particles along its perimeter plus a hub
// particle at the centroid. Adjacent perimeter particles and every
// perimeter->hub pair are joined by stiff springs — a wheel graph, which is
// rigid in 2D, so the molecule holds its shape but stays slightly squishy
// (like the original Molecular Workbench models). Between molecules:
// WCA (purely repulsive Lennard-Jones) contact forces on all particles and
// screened Coulomb on charged particles. Langevin heat bath on every
// particle. Semi-implicit Euler with substeps.
//
// The typed-array state layout here is the reference the GPU backends mirror.

import { BaseEngine } from '../engine.js';
import { pairForce } from '../electrostatics.js';
import { makeRng } from '../../rng.js';

const TARGET_SPACING = 1.5; // perimeter particle spacing (world units)

export function buildSoftLayout(specs, instances) {
  // per-instance particle construction (local space), then instantiate
  const perSpec = specs.map((spec) => {
    const verts = spec.verts;
    const pts = []; // [x, y]
    const edgeStarts = []; // particle index where edge i's subdivision begins
    for (let e = 0; e < verts.length; e++) {
      const [x1, y1] = verts[e];
      const [x2, y2] = verts[(e + 1) % verts.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const nSeg = Math.max(1, Math.round(len / TARGET_SPACING));
      edgeStarts.push(pts.length);
      for (let s = 0; s < nSeg; s++) {
        const t = s / nSeg;
        pts.push([x1 + t * (x2 - x1), y1 + t * (y2 - y1)]);
      }
    }
    const nPerim = pts.length;
    pts.push([0, 0]); // hub at centroid (specs are centroid-centered)

    // charge -> nearest perimeter particle
    const charge = new Float64Array(pts.length);
    for (const [cx, cy, q] of spec.chargeSites()) {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < nPerim; i++) {
        const d = (pts[i][0] - cx) ** 2 + (pts[i][1] - cy) ** 2;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      charge[best] += q;
    }

    // springs: [i, j, restLen]
    const springs = [];
    for (let i = 0; i < nPerim; i++) {
      const j = (i + 1) % nPerim;
      springs.push([i, j, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])]);
      springs.push([i, nPerim, Math.hypot(pts[i][0], pts[i][1])]); // to hub
    }
    return { pts, charge, springs, nPerim };
  });

  let nPart = 0;
  let nSpring = 0;
  for (const inst of instances) {
    nPart += perSpec[inst.spec].pts.length;
    nSpring += perSpec[inst.spec].springs.length;
  }
  const L = {
    n: nPart,
    x: new Float64Array(nPart),
    y: new Float64Array(nPart),
    vx: new Float64Array(nPart),
    vy: new Float64Array(nPart),
    q: new Float64Array(nPart),
    mol: new Int32Array(nPart),
    molStart: new Int32Array(instances.length),
    molCount: new Int32Array(instances.length),
    molPerim: new Int32Array(instances.length),
    sa: new Int32Array(nSpring),
    sb: new Int32Array(nSpring),
    sl: new Float64Array(nSpring),
  };
  let p = 0;
  let sIdx = 0;
  instances.forEach((inst, mi) => {
    const ps = perSpec[inst.spec];
    const c = Math.cos(inst.angle);
    const s = Math.sin(inst.angle);
    L.molStart[mi] = p;
    L.molCount[mi] = ps.pts.length;
    L.molPerim[mi] = ps.nPerim;
    for (const [sa, sb, sl] of ps.springs) {
      L.sa[sIdx] = p + sa;
      L.sb[sIdx] = p + sb;
      L.sl[sIdx] = sl;
      sIdx++;
    }
    ps.pts.forEach(([lx, ly], k) => {
      L.x[p] = inst.x + lx * c - ly * s;
      L.y[p] = inst.y + lx * s + ly * c;
      L.q[p] = ps.charge[k];
      L.mol[p] = mi;
      p++;
    });
  });
  return L;
}

export class SoftEngineCPU extends BaseEngine {
  constructor(opts) {
    super(opts);
    this.kind = 'soft';
    this.backendName = 'soft/cpu';
    this.rng = makeRng(this.seed);
    // soft-engine specific params
    this.params.kSpring = this.params.kSpring ?? 2500;
    this.params.springDamp = this.params.springDamp ?? 8;
    this.params.sigma = this.params.sigma ?? TARGET_SPACING;
    this.params.epsWCA = this.params.epsWCA ?? 4;
    this.params.substeps = this.params.substeps ?? 6;
    this.L = buildSoftLayout(this.specs, this.instances);
    this.fx = new Float64Array(this.L.n);
    this.fy = new Float64Array(this.L.n);
    this._chargedIdx = [];
    for (let i = 0; i < this.L.n; i++) if (this.L.q[i] !== 0) this._chargedIdx.push(i);
    this._sites = {
      x: new Float64Array(this._chargedIdx.length),
      y: new Float64Array(this._chargedIdx.length),
      q: new Float64Array(this._chargedIdx.length),
      mol: new Int32Array(this._chargedIdx.length),
      count: this._chargedIdx.length,
      nMol: this.instances.length,
    };
    this._chargedIdx.forEach((pi, k) => {
      this._sites.q[k] = this.L.q[pi];
      this._sites.mol[k] = this.L.mol[pi];
    });
    // spatial hash sized to WCA cutoff
    this._cell = this.params.sigma * 1.4;
    this._settle();
    this.ready = Promise.resolve(this);
  }

  // resolve any initial overlaps gently: heavily damped, zero-temperature
  // relaxation before the real run starts
  _settle() {
    const saved = { kT: this.params.kT, gamma: this.params.gamma };
    const schedule = this.schedule;
    this.schedule = null;
    this.params.kT = 0;
    this.params.gamma = 30;
    // always the CPU step, even in GPU subclasses (runs before GL init)
    for (let i = 0; i < 40; i++) SoftEngineCPU.prototype.step.call(this);
    this.stepCount = 0;
    this.time = 0;
    this.params.kT = saved.kT;
    this.params.gamma = saved.gamma;
    this.schedule = schedule;
  }

  computeForces() {
    const { L, fx, fy, params } = this;
    fx.fill(0);
    fy.fill(0);

    // springs (with internal damping along the spring axis)
    const { kSpring, springDamp } = params;
    for (let s = 0; s < L.sa.length; s++) {
      const i = L.sa[s];
      const j = L.sb[s];
      let dx = L.x[i] - L.x[j];
      let dy = L.y[i] - L.y[j];
      const d = Math.hypot(dx, dy) + 1e-12;
      dx /= d;
      dy /= d;
      const rel = (L.vx[i] - L.vx[j]) * dx + (L.vy[i] - L.vy[j]) * dy;
      const f = -kSpring * (d - L.sl[s]) - springDamp * rel;
      fx[i] += f * dx;
      fy[i] += f * dy;
      fx[j] -= f * dx;
      fy[j] -= f * dy;
    }

    // WCA contact between particles of different molecules (spatial hash)
    const sigma = params.sigma;
    const eps = params.epsWCA;
    const rc = sigma * Math.pow(2, 1 / 6);
    const rc2 = rc * rc;
    const cell = this._cell;
    const hash = new Map();
    const key = (cx, cy) => cx * 73856093 + cy * 19349663;
    for (let i = 0; i < L.n; i++) {
      const k = key(Math.floor(L.x[i] / cell), Math.floor(L.y[i] / cell));
      let arr = hash.get(k);
      if (!arr) hash.set(k, (arr = []));
      arr.push(i);
    }
    const s2 = sigma * sigma;
    for (let i = 0; i < L.n; i++) {
      const cx = Math.floor(L.x[i] / cell);
      const cy = Math.floor(L.y[i] / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const arr = hash.get(key(cx + ox, cy + oy));
          if (!arr) continue;
          for (const j of arr) {
            if (j <= i) continue;
            if (L.mol[i] === L.mol[j]) continue;
            // opposite-charge "sticky sites" are exempt from contact
            // repulsion so they can bind at close range (their uncharged
            // neighbors still keep the molecules from interpenetrating)
            if (L.q[i] * L.q[j] < 0) continue;
            const dx = L.x[i] - L.x[j];
            const dy = L.y[i] - L.y[j];
            let r2 = dx * dx + dy * dy;
            if (r2 > rc2 || r2 === 0) continue;
            // cap the r^-12 blowup so initial overlaps resolve instead of exploding
            if (r2 < 0.49 * s2) r2 = 0.49 * s2;
            const inv2 = s2 / r2;
            const inv6 = inv2 * inv2 * inv2;
            // WCA: F = 24 eps (2 s^12/r^13 - s^6/r^7) rhat, force/r form:
            const fOverR = (24 * eps * inv6 * (2 * inv6 - 1)) / r2;
            fx[i] += fOverR * dx;
            fy[i] += fOverR * dy;
            fx[j] -= fOverR * dx;
            fy[j] -= fOverR * dy;
          }
        }
      }
    }

    // screened Coulomb between charged particles of different molecules
    const ci = this._chargedIdx;
    const cut2 = params.cutoff * params.cutoff;
    for (let a = 0; a < ci.length; a++) {
      const i = ci[a];
      for (let b = a + 1; b < ci.length; b++) {
        const j = ci[b];
        if (L.mol[i] === L.mol[j]) continue;
        const dx = L.x[i] - L.x[j];
        const dy = L.y[i] - L.y[j];
        if (dx * dx + dy * dy > cut2) continue;
        const [pfx, pfy] = pairForce(dx, dy, L.q[i] * L.q[j], params);
        fx[i] += pfx;
        fy[i] += pfy;
        fx[j] -= pfx;
        fy[j] -= pfy;
      }
    }

    // walls: soft quadratic repulsion inside a margin
    const kWall = 200;
    const margin = 1;
    const hw = this.box.w / 2 - margin;
    const hh = this.box.h / 2 - margin;
    for (let i = 0; i < L.n; i++) {
      if (L.x[i] > hw) fx[i] -= kWall * (L.x[i] - hw);
      else if (L.x[i] < -hw) fx[i] -= kWall * (L.x[i] + hw);
      if (L.y[i] > hh) fy[i] -= kWall * (L.y[i] - hh);
      else if (L.y[i] < -hh) fy[i] -= kWall * (L.y[i] + hh);
    }
  }

  step() {
    this.applySchedule();
    const { L, params } = this;
    const nSub = params.substeps;
    const dt = params.dt / nSub;
    const { gamma, kT } = params;
    const kick = Math.sqrt((2 * gamma * kT) / dt); // force-scale kick, m=1
    for (let sub = 0; sub < nSub; sub++) {
      this.computeForces();
      const vMax = 80; // safety clamp against numerical blowups
      for (let i = 0; i < L.n; i++) {
        const ax = this.fx[i] - gamma * L.vx[i] + kick * this.rng.gauss();
        const ay = this.fy[i] - gamma * L.vy[i] + kick * this.rng.gauss();
        L.vx[i] += ax * dt;
        L.vy[i] += ay * dt;
        const v2 = L.vx[i] * L.vx[i] + L.vy[i] * L.vy[i];
        if (v2 > vMax * vMax) {
          const f = vMax / Math.sqrt(v2);
          L.vx[i] *= f;
          L.vy[i] *= f;
        }
        L.x[i] += L.vx[i] * dt;
        L.y[i] += L.vy[i] * dt;
      }
    }
    this.stepCount++;
    this.time += params.dt;
  }

  poses() {
    const out = [];
    const { L } = this;
    for (let mi = 0; mi < this.instances.length; mi++) {
      const s = L.molStart[mi];
      const hub = s + L.molCount[mi] - 1;
      out.push({ x: L.x[hub], y: L.y[hub], angle: 0 });
    }
    return out;
  }

  outlines() {
    const out = [];
    const { L } = this;
    for (let mi = 0; mi < this.instances.length; mi++) {
      const s = L.molStart[mi];
      const nP = L.molPerim[mi];
      const poly = [];
      for (let k = 0; k < nP; k++) poly.push([L.x[s + k], L.y[s + k]]);
      out.push(poly);
    }
    return out;
  }

  chargeWorld() {
    const { L } = this;
    this._chargedIdx.forEach((pi, k) => {
      this._sites.x[k] = L.x[pi];
      this._sites.y[k] = L.y[pi];
    });
    return this._sites;
  }

  free() {}
}
