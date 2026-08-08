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
const TUNED = { k: 6, lambda: 1.4, soft: 0.5, gamma: 0.3, cutoff: 9, friction: 0.1, restitution: 0.05 };
const ANNEAL = { Tstart: 1.7, Tend: 0.3, holdSteps: 50000, coolSteps: 50000 };

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
