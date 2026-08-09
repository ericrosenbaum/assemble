// Scenario presets: a molecule set + box + placement + physics params +
// temperature schedule, everything needed for a reproducible run.

import { wedge, MoleculeSpec } from './shapes.js';
import { TemperatureSchedule, scatterInstances } from './sim/engine.js';
import { makeRng } from './rng.js';

export function buildScenario(name, overrides = {}) {
  const def = { ...(SCENARIOS[name] ?? SCENARIOS['wedge-8']).config, ...overrides };
  const spec = def.spec();
  const box = { w: def.boxW, h: def.boxH };
  const rng = makeRng(def.seed);
  const instances = scatterInstances({ count: def.count, box, spec, rng });
  return {
    name,
    specs: [spec],
    instances,
    box,
    seed: def.seed,
    params: def.params,
    paramsSoft: { ...SOFT_TUNED, ...(def.paramsSoft ?? {}) },
    schedule: new TemperatureSchedule(def.schedule),
    nRing: spec._nRing,
    def,
  };
}

// Physics tuned in the wedge-ring experiments (see results/):
//  - k=6, lambda=1.4, soft=0.5: full-face binding ≈ 42 units, a single
//    misregistered pair ≈ 12, so at T≈1.7 wrong bonds break (≈7 kT) while
//    correct joints hold (≈25 kT)
//  - long hold in that selective window, then cool to lock structures
//  - low friction so faces can slide into registration while docking
// dt = 1/60 rather than 1/120: a sweep over dt (tools/sweep.mjs, 3 seeds,
// schedules rescaled so simulated time is held constant) showed 1/60 reaching
// assembly in about half the wall-clock with ring yield no worse — and a
// dense/hot stress test (90 molecules in a 64-unit box) found the same minimum
// centre separation and peak speeds as 1/120, so contacts are not being
// tunnelled through. Schedule step counts below are halved to match, keeping
// the annealing profile identical in simulated time.
const TUNED = {
  dt: 1 / 60,
  k: 6,
  lambda: 1.4,
  soft: 0.5,
  gamma: 0.3,
  cutoff: 9,
  friction: 0.1,
  restitution: 0.05,
};
const ANNEAL = { Tstart: 1.7, Tend: 0.3, holdSteps: 25000, coolSteps: 25000 };
// The soft engine binds through sticky sites that WCA shells keep ~1 unit
// apart, so it needs a stronger charge constant and a smaller particle
// diameter to reach the same binding-energy/kT ratios as the rigid engine.
// It keeps dt = 1/120: its substep is dt/substeps against very stiff springs
// (kSpring 2500), so doubling dt would double the substep and eat the
// integrator's stability margin, which the dt sweep above did not test.
const SOFT_TUNED = { k: 25, sigma: 1.2, dt: 1 / 120 };

export const SCENARIOS = {
  'wedge-8': {
    label: '8-wedge rings (microtubule)',
    config: {
      spec: () => wedge({ nRing: 8, rInner: 4, rOuter: 9 }),
      count: 32,
      boxW: 64,
      boxH: 64,
      seed: 7,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'wedge-8-classic': {
    label: '8-wedge rings (2005 article layout)',
    config: {
      spec: () => wedge({ nRing: 8, rInner: 4, rOuter: 9, chargeT: null, chargeQ: null }),
      count: 32,
      boxW: 64,
      boxH: 64,
      seed: 7,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'wedge-6': {
    label: '6-wedge rings',
    config: {
      spec: () => wedge({ nRing: 6, rInner: 3.5, rOuter: 8.5 }),
      count: 24,
      boxW: 58,
      boxH: 58,
      seed: 11,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'wedge-12': {
    label: '12-wedge rings',
    config: {
      spec: () => wedge({ nRing: 12, rInner: 6, rOuter: 11 }),
      count: 36,
      boxW: 86,
      boxH: 86,
      seed: 3,
      params: { ...TUNED },
      schedule: { ...ANNEAL, Tstart: 1.6 },
    },
  },
};

export { MoleculeSpec };
