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
import { makeRng } from '../../rng.js';
import { CellGrid } from '../cellgrid.js';

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
    // Two grids: contacts are very short-ranged (WCA cutoff ~1.12 sigma) while
    // Coulomb reaches `cutoff`, so a single cell size would either scan huge
    // cells for contacts or miss Coulomb neighbours.
    this._gridWCA = new CellGrid({
      box: this.box,
      cell: this.params.sigma * Math.pow(2, 1 / 6),
      capacity: this.L.n,
    });
    this._gridCoulomb = new CellGrid({
      box: this.box,
      cell: this.params.cutoff,
      capacity: this.L.n,
    });
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

    // WCA contact between particles of different molecules, via the
    // preallocated cell grid (3x3 neighbourhood; cell size == WCA cutoff).
    const sigma = params.sigma;
    const eps = params.epsWCA;
    const rc = sigma * Math.pow(2, 1 / 6);
    const rc2 = rc * rc;
    const s2 = sigma * sigma;
    const g = this._gridWCA;
    g.build(L.x, L.y, L.n);
    const gItems = g.items;
    const gStart = g.cellStart;
    const gnx = g.nx;
    const gny = g.ny;
    for (let i = 0; i < L.n; i++) {
      const cx = g.cellX(L.x[i]);
      const cy = g.cellY(L.y[i]);
      const xi = L.x[i];
      const yi = L.y[i];
      const mi = L.mol[i];
      const qi = L.q[i];
      let fxi = 0;
      let fyi = 0;
      const y0 = cy > 0 ? cy - 1 : 0;
      const y1 = cy < gny - 1 ? cy + 1 : gny - 1;
      const x0 = cx > 0 ? cx - 1 : 0;
      const x1 = cx < gnx - 1 ? cx + 1 : gnx - 1;
      for (let ny = y0; ny <= y1; ny++) {
        const rowBase = ny * gnx;
        for (let nx = x0; nx <= x1; nx++) {
          const c = rowBase + nx;
          const end = gStart[c + 1];
          for (let t = gStart[c]; t < end; t++) {
            const j = gItems[t];
            if (j <= i) continue;
            if (mi === L.mol[j]) continue;
            // opposite-charge "sticky sites" are exempt from contact
            // repulsion so they can bind at close range (their uncharged
            // neighbors still keep the molecules from interpenetrating)
            if (qi * L.q[j] < 0) continue;
            const dx = xi - L.x[j];
            const dy = yi - L.y[j];
            let r2 = dx * dx + dy * dy;
            if (r2 > rc2 || r2 === 0) continue;
            // cap the r^-12 blowup so initial overlaps resolve instead of exploding
            if (r2 < 0.49 * s2) r2 = 0.49 * s2;
            const inv2 = s2 / r2;
            const inv6 = inv2 * inv2 * inv2;
            // WCA: F = 24 eps (2 s^12/r^13 - s^6/r^7) rhat, force/r form:
            const fOverR = (24 * eps * inv6 * (2 * inv6 - 1)) / r2;
            const ax = fOverR * dx;
            const ay = fOverR * dy;
            fxi += ax;
            fyi += ay;
            fx[j] -= ax;
            fy[j] -= ay;
          }
        }
      }
      fx[i] += fxi;
      fy[i] += fyi;
    }

    // Screened Coulomb between charged particles of different molecules, on
    // its own grid (cell size == Coulomb cutoff, charged particles only).
    // Force kernel inlined so there is no per-pair array allocation.
    const cg = this._gridCoulomb;
    cg.build(L.x, L.y, L.n, this._chargedIdx);
    const cItems = cg.items;
    const cStart = cg.cellStart;
    const cnx = cg.nx;
    const cny = cg.ny;
    const cut2 = params.cutoff * params.cutoff;
    const soft2 = params.soft * params.soft;
    const invLambda = 1 / params.lambda;
    const kC = params.k;
    const chargedIdx = this._chargedIdx;
    for (let a = 0; a < chargedIdx.length; a++) {
      const i = chargedIdx[a];
      const cx = cg.cellX(L.x[i]);
      const cy = cg.cellY(L.y[i]);
      const xi = L.x[i];
      const yi = L.y[i];
      const mi = L.mol[i];
      const qi = L.q[i];
      let fxi = 0;
      let fyi = 0;
      const y0 = cy > 0 ? cy - 1 : 0;
      const y1 = cy < cny - 1 ? cy + 1 : cny - 1;
      const x0 = cx > 0 ? cx - 1 : 0;
      const x1 = cx < cnx - 1 ? cx + 1 : cnx - 1;
      for (let ny = y0; ny <= y1; ny++) {
        const rowBase = ny * cnx;
        for (let nx = x0; nx <= x1; nx++) {
          const c = rowBase + nx;
          const end = cStart[c + 1];
          for (let t = cStart[c]; t < end; t++) {
            const j = cItems[t];
            if (j <= i) continue;
            if (mi === L.mol[j]) continue;
            const dx = xi - L.x[j];
            const dy = yi - L.y[j];
            const r2 = dx * dx + dy * dy;
            if (r2 > cut2) continue;
            // must match pairForce() exactly — softened distance in exp() too
            const rs = Math.sqrt(r2 + soft2);
            const dUdrs = ((kC * qi * L.q[j] * Math.exp(-rs * invLambda)) / rs) * (-invLambda - 1 / rs);
            const f = -dUdrs / rs;
            const ax = f * dx;
            const ay = f * dy;
            fxi += ax;
            fyi += ay;
            fx[j] -= ax;
            fy[j] -= ay;
          }
        }
      }
      fx[i] += fxi;
      fy[i] += fyi;
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
