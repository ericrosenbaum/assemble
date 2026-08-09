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
export class TemperatureSchedule {
  constructor({ Tstart = 3.0, Tend = 0.15, holdSteps = 600, coolSteps = 6000 } = {}) {
    Object.assign(this, { Tstart, Tend, holdSteps, coolSteps });
  }
  at(step) {
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
}

// Random non-overlapping-ish initial placement inside the box. Uses an
// area-based effective radius and progressively relaxes the spacing
// constraint so the requested count always fits (contacts at t=0 just get
// pushed apart by the collision forces).
// Place a mixture of species. Molecules are interleaved rather than placed
// species-by-species, so the starting state is genuinely mixed instead of
// segregated — otherwise a two-species run would spend its whole anneal just
// undoing the initial demixing.
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
  while (placed.length < order.length) {
    let attempts = 0;
    while (placed.length < order.length && attempts < 5000) {
      attempts++;
      const x = rEdge + rng.next() * (box.w - 2 * rEdge) - box.w / 2;
      const y = rEdge + rng.next() * (box.h - 2 * rEdge) - box.h / 2;
      let ok = true;
      for (const p of placed) {
        const dx = p.x - x;
        const dy = p.y - y;
        if (dx * dx + dy * dy < minDist * minDist) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      placed.push({ spec: order[placed.length], x, y, angle: rng.next() * Math.PI * 2 });
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
  while (placed.length < count) {
    let attempts = 0;
    while (placed.length < count && attempts < 5000) {
      attempts++;
      const x = rEdge + rng.next() * (box.w - 2 * rEdge) - box.w / 2;
      const y = rEdge + rng.next() * (box.h - 2 * rEdge) - box.h / 2;
      let ok = true;
      for (const p of placed) {
        const dx = p.x - x;
        const dy = p.y - y;
        if (dx * dx + dy * dy < minDist * minDist) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      placed.push({ spec: specIndex, x, y, angle: rng.next() * Math.PI * 2 });
    }
    minDist *= 0.85; // relax and keep going if the box is crowded
    if (minDist < 0.5) break;
  }
  return placed;
}
