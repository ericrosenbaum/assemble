// Scenario presets: a molecule set + box + placement + physics params +
// temperature schedule, everything needed for a reproducible run.

import { wedge, facePair, tiler, POLAR_T, POLAR_MIRROR_T, MoleculeSpec } from './shapes.js';
import { TemperatureSchedule, scatterInstances, scatterMixture } from './sim/engine.js';
import { makeRng } from './rng.js';

// A two-species pair. Each species keeps + on its out-face and − on its
// in-face, which is what gives a molecule a direction and makes chains curl
// consistently instead of zigzagging. Species specificity comes from the
// charge *positions* instead: A carries the same layout on both faces and B
// the mirrored one, so a face only ever registers against the other species.
const speciesA = (opts) => facePair({ chargeT: POLAR_T, chargeTk: POLAR_T, ...opts });
const speciesB = (opts) =>
  facePair({ chargeT: POLAR_MIRROR_T, chargeTk: POLAR_MIRROR_T, ...opts });

// Box side that holds the given molecules at a target area packing fraction.
// Density matters as much as the charge parameters — too sparse and molecules
// rarely meet, too dense and everything jams before it can anneal — so shapes
// of different sizes are sized to a common fraction rather than a hand-picked
// box each.
export function boxForPacking(specs, counts, packing = 0.17) {
  const area = specs.reduce((a, s, i) => a + Math.abs(s.area()) * counts[i], 0);
  return Math.round(Math.sqrt(area / packing));
}

export function buildScenario(name, overrides = {}) {
  const def = { ...(SCENARIOS[name] ?? SCENARIOS['wedge-8']).config, ...overrides };

  // A scenario is either a single species (spec/count) or a mixture
  // (species: [{spec, count}, ...]).
  const mixture = def.species
    ? def.species.map((s) => ({ spec: s.spec(), count: s.count }))
    : [{ spec: def.spec(), count: def.count }];
  const specs = mixture.map((m) => m.spec);
  const counts = mixture.map((m) => m.count);

  const side = def.packing ? boxForPacking(specs, counts, def.packing) : null;
  const box = { w: def.boxW ?? side, h: def.boxH ?? side };
  const rng = makeRng(def.seed);
  const instances =
    specs.length > 1
      ? scatterMixture({ specs, counts, box, rng })
      : scatterInstances({ count: counts[0], box, spec: specs[0], rng });

  return {
    name,
    specs,
    instances,
    box,
    seed: def.seed,
    params: def.params,
    paramsSoft: { ...SOFT_TUNED, ...(def.paramsSoft ?? {}) },
    schedule: new TemperatureSchedule(def.schedule),
    nRing: specs[0]._nRing,
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
// Bigger target rings need a longer search: every molecule carries just two
// binding faces, so a 6- or 10-ring only closes after that many correct
// encounters in a row, and the hold is where wrong bonds get a chance to
// break. Small targets (2x2 blocks, trimers) close fine on the short anneal.
const LONG_ANNEAL = { Tstart: 1.7, Tend: 0.3, holdSteps: 70000, coolSteps: 35000 };
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

  // --- regular-polygon family -------------------------------------------
  // Each of these is a regular n-gon with a + face and a − face k edges
  // apart. That single choice fixes what it can build: m = 2n/(n-2k), the
  // rule verified in test/geometry.test.mjs. Same charge parameters
  // throughout — the structures differ because of geometry, not tuning.

  'square-2x2': {
    label: 'squares → 2×2 blocks',
    config: {
      spec: () => facePair({ n: 4, k: 1, name: 'square-2x2', color: '#7fb069' }),
      count: 32,
      packing: 0.17,
      seed: 5,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'square-sheet': {
    label: 'squares → lattice sheet',
    config: {
      spec: () => tiler({ n: 4, name: 'square-sheet', color: '#5fb0a5' }),
      count: 36,
      packing: 0.40,
      seed: 8,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'hex-trimer': {
    label: 'hexagons → trimers (k=1)',
    config: {
      spec: () => facePair({ n: 6, k: 1, name: 'hex-trimer', color: '#6c91bf' }),
      count: 30,
      packing: 0.22,
      seed: 4,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'hex-ring6': {
    label: 'hexagons → 6-rings (k=2)',
    config: {
      spec: () => facePair({ n: 6, k: 2, name: 'hex-ring6', color: '#8a7fb0' }),
      count: 30,
      packing: 0.25,
      seed: 6,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },
  'hex-fiber': {
    label: 'hexagons → straight fibres (k=3)',
    config: {
      spec: () => facePair({ n: 6, k: 3, name: 'hex-fiber', color: '#c76f8a' }),
      count: 30,
      packing: 0.25,
      seed: 9,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },
  'hex-sheet': {
    label: 'hexagons → honeycomb sheet',
    config: {
      spec: () => tiler({ n: 6, name: 'hex-sheet', color: '#e8b04b' }),
      count: 30,
      packing: 0.4,
      seed: 2,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },
  'tri-rosette': {
    label: 'triangles → 6-rosettes',
    config: {
      spec: () => facePair({ n: 3, k: 1, name: 'tri-rosette', color: '#d98b4a' }),
      count: 36,
      packing: 0.15,
      seed: 7,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'pent-ring10': {
    label: 'pentagons → 10-rings',
    config: {
      spec: () => facePair({ n: 5, k: 2, name: 'pent-ring10', color: '#5aa9a0' }),
      count: 30,
      packing: 0.25,
      seed: 3,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },

  // --- two-species mixtures ---------------------------------------------
  // Every face of species A carries +, every face of B carries −, so A cannot
  // bind A and B cannot bind B: the only stable bond is A–B and structures
  // alternate strictly. The ring size follows from the same turn-sum rule,
  // now over both species — p pairs close when p(turn_A + turn_B) is a whole
  // revolution. Faces use POLAR_T so a reversed junction is ~9x weaker.

  'tri-hex-4ring': {
    label: 'triangles + hexagons → 4-rings',
    config: {
      species: [
        {
          spec: () =>
            speciesA({ n: 3, k: 1, name: 'triangle A', color: '#e8b04b' }),
          count: 20,
        },
        {
          spec: () =>
            speciesB({ n: 6, k: 1, name: 'hexagon B', color: '#6c91bf' }),
          count: 20,
        },
      ],
      packing: 0.2,
      seed: 12,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'square-hex-8ring': {
    label: 'squares + hexagons → 8-rings',
    config: {
      species: [
        {
          spec: () =>
            speciesA({ n: 4, k: 1, name: 'square A', color: '#7fb069' }),
          count: 16,
        },
        {
          spec: () =>
            speciesB({ n: 6, k: 3, name: 'hexagon B', color: '#c76f8a' }),
          count: 16,
        },
      ],
      packing: 0.2,
      seed: 14,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },
  'tri-hex-12ring': {
    label: 'triangles + hexagons → 12-rings',
    config: {
      species: [
        {
          spec: () =>
            speciesA({ n: 3, k: 1, name: 'triangle A', color: '#d98b4a' }),
          count: 18,
        },
        {
          spec: () =>
            speciesB({ n: 6, k: 3, name: 'hexagon B', color: '#8a7fb0' }),
          count: 18,
        },
      ],
      packing: 0.2,
      seed: 15,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },
  'salt-lattice': {
    label: 'two squares → checkerboard lattice',
    config: {
      species: [
        {
          spec: () =>
            tiler({ n: 4, uniformSign: 1, chargeT: POLAR_T, name: 'square +', color: '#e8b04b' }),
          count: 18,
        },
        {
          spec: () =>
            tiler({ n: 4, uniformSign: -1, chargeT: POLAR_T, name: 'square −', color: '#5fb0a5' }),
          count: 18,
        },
      ],
      packing: 0.4,
      seed: 16,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },
};

export { MoleculeSpec };
