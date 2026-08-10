// Common engine layer: parameter defaults, temperature schedule, and the
// interface both backends (rigid, soft) implement.
//
// Engine interface:
//   await engine.ready            — resolves when backend is initialized
//   engine.step()                 — advance one timestep (bath + forces)
//   engine.molecules              — [{spec, index}] static info
//   engine.poses()                — [{x, y, angle}] per molecule (rigid pose
//                                   or best-fit pose for soft bodies)
//   engine.outlines()             — [[x,y]...] world-space outline per molecule
//   engine.chargeWorld()          — {x, y, q, mol, count} world-space sites
//   engine.params                 — live-tunable physics params
//   engine.time, engine.stepCount

export const defaultParams = {
  dt: 1 / 120,
  // heat bath
  kT: 1.0, // current temperature (live)
  gamma: 1.2, // drag coefficient (1/s-ish)
  // electrostatics
  k: 60, // Coulomb strength
  lambda: 2.0, // screening length
  soft: 0.45, // softening radius (also sets the force's spring length at contact)
  cutoff: 10, // interaction cutoff
  // contact
  restitution: 0.15,
  friction: 0.05,
  density: 0.4, // lighter molecules diffuse faster in the bath
};

// Annealing schedule: hold hot, then exponential-ish cool to Tend.
//
// `mode` selects the protocol. The default 'anneal' is the classic hold-then-
// cool and is what every preset used before the schedule search; the others
// exist because "cool slowly" is a folk rule worth testing rather than
// assuming (see tools/anneal_search.mjs):
//
//   anneal  hold at Tstart, then cool geometrically to Tend
//   steady  hold one temperature forever
//   cycle   oscillate between Thot and Tcold with period `periodSteps`,
//           optionally drifting the mean downward via `coolSteps`
//
// Cycling is the interesting one: a bond that is wrong is weaker than a bond
// that is right, so a hot phase should preferentially melt mistakes while
// leaving correct structure intact — an anneal that gets repeated attempts
// instead of one.
export class TemperatureSchedule {
  constructor({
    Tstart = 3.0,
    Tend = 0.15,
    holdSteps = 600,
    coolSteps = 6000,
    mode = 'anneal',
    // cycle-only
    Thot = null,
    Tcold = null,
    periodSteps = 10000,
    duty = 0.5, // fraction of each period spent hot
  } = {}) {
    Object.assign(this, {
      Tstart,
      Tend,
      holdSteps,
      coolSteps,
      mode,
      Thot: Thot ?? Tstart,
      Tcold: Tcold ?? Tend,
      periodSteps,
      duty,
    });
  }

  at(step) {
    if (this.mode === 'steady') return this.Tstart;

    if (this.mode === 'cycle') {
      if (step <= this.holdSteps) return this.Thot;
      const s = step - this.holdSteps;
      const phase = (s % this.periodSteps) / this.periodSteps;
      const hot = phase < this.duty;
      // Optional downward drift of both rails, so a cycling run can still end
      // cold enough to lock structures in.
      const u = this.coolSteps > 0 ? Math.min(1, s / this.coolSteps) : 0;
      const scale = Math.pow(this.Tend / this.Thot, u);
      return (hot ? this.Thot : this.Tcold) * (this.coolSteps > 0 ? scale : 1);
    }

    if (step <= this.holdSteps) return this.Tstart;
    const u = Math.min(1, (step - this.holdSteps) / this.coolSteps);
    // exponential interpolation reads as "gradual cooling" visually
    return this.Tstart * Math.pow(this.Tend / this.Tstart, u);
  }
}

export class BaseEngine {
  constructor({ specs, instances, box, params = {}, seed = 1, schedule = null }) {
    this.specs = specs;
    this.instances = instances; // [{spec: index into specs, x, y, angle}]
    this.box = box; // {w, h}
    this.params = { ...defaultParams, ...params };
    this.seed = seed;
    this.schedule = schedule;
    this.stepCount = 0;
    this.time = 0;
  }

  applySchedule() {
    if (this.schedule) this.params.kT = this.schedule.at(this.stepCount);
  }

  // Write world-space outline vertices into a flat preallocated buffer as
  // [x0,y0, x1,y1, ...], molecule after molecule.
  //
  // outlines() returns nested arrays, which is convenient but allocates one
  // array per molecule plus one per vertex — every frame. At a few hundred
  // molecules that is invisible; at tens of thousands it is hundreds of
  // thousands of allocations per snapshot, and the GC cost swamps the
  // simulation. Backends override this to fill the buffer directly; the
  // default keeps the contract for anything that hasn't.
  fillOutlines(out) {
    let k = 0;
    for (const poly of this.outlines()) {
      for (const [x, y] of poly) {
        out[k++] = x;
        out[k++] = y;
      }
    }
    return k;
  }

  // Write [x, y, angle] per molecule into a flat preallocated buffer.
  //
  // A rigid molecule's on-screen geometry is fully determined by its pose, so
  // this is all the instanced renderer needs — three floats per molecule
  // instead of two per vertex. It is also what the worker posts, which shrinks
  // the per-frame transfer by roughly 5x.
  fillPoses(out) {
    let k = 0;
    for (const p of this.poses()) {
      out[k++] = p.x;
      out[k++] = p.y;
      out[k++] = p.angle;
    }
    return k;
  }
}

// Random non-overlapping-ish initial placement inside the box. Uses an
// area-based effective radius and progressively relaxes the spacing
// constraint so the requested count always fits (contacts at t=0 just get
// pushed apart by the collision forces).
// Place a mixture of species. Molecules are interleaved rather than placed
// species-by-species, so the starting state is genuinely mixed instead of
// segregated — otherwise a two-species run would spend its whole anneal just
// undoing the initial demixing.
// Rejection sampling checked each candidate against every molecule already
// placed, which is O(N^2) and became the slowest part of starting a large run.
// A hash grid at the rejection radius makes it O(N): only the 3x3
// neighbourhood can contain a violating neighbour.
//
// The radius shrinks as the box fills (see the callers), so the grid is rebuilt
// whenever it changes rather than being kept incrementally.
class PlacementGrid {
  constructor() {
    this.cell = 1;
    this.map = new Map();
  }
  reset(cell, placed) {
    this.cell = cell;
    this.map = new Map();
    for (let i = 0; i < placed.length; i++) this.add(placed[i]);
  }
  key(x, y) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }
  add(p) {
    const k = this.key(p.x, p.y);
    let bucket = this.map.get(k);
    if (!bucket) this.map.set(k, (bucket = []));
    bucket.push(p);
  }
  // true if anything already placed is within `dist` of (x, y)
  crowded(x, y, dist) {
    const d2 = dist * dist;
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = this.map.get(`${cx + ox},${cy + oy}`);
        if (!bucket) continue;
        for (const p of bucket) {
          const dx = p.x - x;
          const dy = p.y - y;
          if (dx * dx + dy * dy < d2) return true;
        }
      }
    }
    return false;
  }
}

export function scatterMixture({ specs, counts, box, rng, margin = 1 }) {
  const order = [];
  for (let i = 0; i < specs.length; i++) for (let c = 0; c < counts[i]; c++) order.push(i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const maxEdge = Math.max(...specs.map((s) => s.boundingRadius()));
  const meanArea = specs.reduce((a, s, i) => a + Math.abs(s.area()) * counts[i], 0) / order.length;
  const rEdge = maxEdge * 0.8 + margin;
  let minDist = 2.3 * Math.sqrt(meanArea / Math.PI);
  const placed = [];
  const grid = new PlacementGrid();
  while (placed.length < order.length) {
    grid.reset(minDist, placed);
    let attempts = 0;
    while (placed.length < order.length && attempts < 5000) {
      attempts++;
      const x = rEdge + rng.next() * (box.w - 2 * rEdge) - box.w / 2;
      const y = rEdge + rng.next() * (box.h - 2 * rEdge) - box.h / 2;
      if (grid.crowded(x, y, minDist)) continue;
      const p = { spec: order[placed.length], x, y, angle: rng.next() * Math.PI * 2 };
      placed.push(p);
      grid.add(p);
    }
    minDist *= 0.85;
    if (minDist < 0.5) break;
  }
  return placed;
}

export function scatterInstances({ specIndex = 0, count, box, spec, rng, margin = 1 }) {
  const placed = [];
  const rEdge = spec.boundingRadius() * 0.8 + margin; // keep clear of walls
  let minDist = 2.3 * Math.sqrt(spec.area() / Math.PI);
  const grid = new PlacementGrid();
  while (placed.length < count) {
    grid.reset(minDist, placed);
    let attempts = 0;
    while (placed.length < count && attempts < 5000) {
      attempts++;
      const x = rEdge + rng.next() * (box.w - 2 * rEdge) - box.w / 2;
      const y = rEdge + rng.next() * (box.h - 2 * rEdge) - box.h / 2;
      if (grid.crowded(x, y, minDist)) continue;
      const p = { spec: specIndex, x, y, angle: rng.next() * Math.PI * 2 };
      placed.push(p);
      grid.add(p);
    }
    minDist *= 0.85; // relax and keep going if the box is crowded
    if (minDist < 0.5) break;
  }
  return placed;
}
