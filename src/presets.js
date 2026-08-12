// Scenario presets: a molecule set + box + placement + physics params +
// temperature schedule, everything needed for a reproducible run.

import {
  wedge,
  facePair,
  tiler,
  hub,
  rod,
  notchedBlock,
  wedgeKey,
  dockingMonomer,
  POLAR_T,
  POLAR_MIRROR_T,
  MoleculeSpec,
  keyCycle,
} from './shapes.js';
import { TemperatureSchedule, scatterInstances, scatterMixture } from './sim/engine.js';
import { makeRng } from './rng.js';

// One link of a keyed cycle as an n-gon: presents key i on its out-face and the
// complement of key i−1 on its in-face, so it can only follow species i−1.
// q = 0.8 rather than 1: eight charge pairs per interface total about -80
// energy units at unit charge, twice the wedge's -42 that everything else here
// is tuned around. That is not merely "stronger" — it is too stiff for
// dt = 1/60, and measured 6.8x equilibrium kinetic energy, which is the
// integrator coming apart rather than a thermodynamic result. Scaling the
// charge brings the interface back into the tuned range (energy goes as q^2).
const keyedPolygon = (n, k, i, name, color, cycle = 3) => {
  const key = keyCycle(i, cycle);
  return facePair({
    n,
    k,
    q: 0.8,
    chargeT: key.outT,
    chargeTk: key.inT,
    signs: [key.outQ, key.inQ],
    name,
    color,
  });
};

// A terminator: carries only the in-face that accepts species i, and nothing
// else. Built from the same helper and then stripped of its out-face, so the
// binding interface is bit-identical to the one it competes with — the cap wins
// or loses on concentration, not on being a better partner.
const keyedCap = (i, cycle, name, color) => {
  const spec = keyedPolygon(4, 1, (i + 1) % cycle, name, color, cycle);
  spec.charges = spec.charges.filter((c) => c.edge === spec._k % spec._n);
  spec._capOf = i;
  return spec;
};

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

  // `boxScale` stretches the container without touching the molecule count, so
  // the UI can trade density against room to move. It multiplies the side, so
  // area — and therefore packing fraction — goes as the square: 1.4x the side
  // is half the density. Applied to whichever box the scenario would otherwise
  // have used, packing-derived or explicit.
  const side = def.packing ? boxForPacking(specs, counts, def.packing) : null;
  const scale = def.boxScale ?? 1;
  const box = {
    w: Math.round((def.boxW ?? side) * scale),
    h: Math.round((def.boxH ?? side) * scale),
  };
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
  // 0.38 rather than 0.5: the kernel now uses the softened distance inside the
  // exponential as well (see electrostatics.js), which would otherwise shallow
  // the contact well by ~30%. At 0.38 the well depth is -12.04 against the old
  // -12.00 and the long range moves <1%, so every preset's tuning carries over.
  soft: 0.38,
  gamma: 0.3,
  cutoff: 9,
  friction: 0.1,
  restitution: 0.05,
};
// Hold hot for most of the run, then quench sharply — rather than the classic
// "cool slowly from hot", which these presets inherited by convention and which
// a search (tools/anneal_search.mjs) found to be close to the worst option
// available.
//
// Two things are going on, and both argue against cooling.
//
// Error correction costs thermal energy. Cool to kT = 0.3 and a misregistered
// bond is ~40 kT — permanent. The cooling phase does not refine anything, it
// switches off the process that was fixing mistakes, and does so while plenty
// of mistakes remain. That alone is worth roughly 2x.
//
// The rest comes from holding much hotter than a bond-level argument suggests,
// because what matters is *cluster* stability. At kT = 7.5 a single correct
// full-face bond (~42 energy units) is only ~5.6 kT, so a half-finished cluster
// hanging off one bond comes apart readily. A closed 8-ring cannot leave by one
// bond: it has to break two at once, ~11 kT, which is rare. So the bath
// dissolves partial and misassembled material while finished rings sit there
// and keep collecting monomers. Below ~7 the junk survives too; above ~11 the
// two-bond barrier starts falling as well and the rings go with it.
//
// Measured on wedge-8 over 12 seeds at 320 molecules, correct 8-rings after an
// identical final quench (tools/anneal_search.mjs):
//
//   hold 1.7 then cool (the original)   4.3 rings, 34% of rings correct
//   hold 2.7 then quench                7.8 rings, 49%
//   steady 6.5                          8.4 rings, 53%
//   hold 7.5 then quench (this)        10.8 rings, 69%
//   steady 7.5 / 9.0                   11.4 / 11.2 rings, 73% / 78%
//
// 7.5 and 9.0 tie within noise, so this sits on a plateau rather than a peak —
// the sharp part is the threshold near 7, below which yield collapses back to
// the old numbers. The quench costs a little against staying hot but ends cold,
// so structures freeze for display instead of continuing to turn over.
const ANNEAL = { Tstart: 7.5, Tend: 0.3, holdSteps: 42000, coolSteps: 8000 };
// Bigger target rings need a longer search: every molecule carries just two
// binding faces, so a 6- or 10-ring only closes after that many correct
// encounters in a row, and the hold is where wrong bonds get a chance to
// break. Small targets (2x2 blocks, trimers) close fine on the short anneal.
const LONG_ANNEAL = { Tstart: 7.5, Tend: 0.3, holdSteps: 110000, coolSteps: 20000 };
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
      count: 320,
      packing: 0.18,
      seed: 7,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'wedge-8-classic': {
    label: '8-wedge rings (2005 article layout)',
    config: {
      spec: () => wedge({ nRing: 8, rInner: 4, rOuter: 9, chargeT: null, chargeQ: null }),
      count: 320,
      packing: 0.18,
      seed: 7,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'wedge-6': {
    label: '6-wedge rings',
    config: {
      spec: () => wedge({ nRing: 6, rInner: 3.5, rOuter: 8.5 }),
      count: 240,
      packing: 0.185,
      seed: 11,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'wedge-12': {
    label: '12-wedge rings',
    config: {
      spec: () => wedge({ nRing: 12, rInner: 6, rOuter: 11 }),
      count: 360,
      packing: 0.103,
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
      count: 320,
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
      count: 360,
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
      count: 300,
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
      count: 300,
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
      count: 300,
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
      count: 300,
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
      count: 360,
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
      count: 300,
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
          count: 200,
        },
        {
          spec: () =>
            speciesB({ n: 6, k: 1, name: 'hexagon B', color: '#6c91bf' }),
          count: 200,
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
          count: 160,
        },
        {
          spec: () =>
            speciesB({ n: 6, k: 3, name: 'hexagon B', color: '#c76f8a' }),
          count: 160,
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
          count: 180,
        },
        {
          spec: () =>
            speciesB({ n: 6, k: 3, name: 'hexagon B', color: '#8a7fb0' }),
          count: 180,
        },
      ],
      packing: 0.2,
      seed: 15,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },
  // --- hub and arm: stars ------------------------------------------------
  // From the article's open-ended "make your own molecule" page. A hub
  // carries + on every face; an arm is a long rectangle with − on one short
  // face only. Hub–hub and arm–arm are therefore repulsive and the only bond
  // is hub–arm, so each hub gathers as many arms as it has faces and the
  // result is a finite star. Nothing has to close, which is why these
  // assemble far more readily than the larger rings.
  //
  // Arms are given in slight excess of the hub valence so hubs can saturate,
  // and the box is packed a little denser than the ring presets since
  // encounter rate is the only thing limiting these.

  'star-3': {
    label: 'triangles + rods → 3-armed stars',
    config: {
      species: [
        { spec: () => hub({ n: 3, name: 'triangle hub', color: '#e8b04b' }), count: 100 },
        { spec: () => rod({ name: 'arm', color: '#6c91bf' }), count: 340 },
      ],
      packing: 0.22,
      seed: 21,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'star-4': {
    label: 'squares + rods → 4-armed crosses',
    config: {
      species: [
        { spec: () => hub({ n: 4, name: 'square hub', color: '#7fb069' }), count: 80 },
        { spec: () => rod({ name: 'arm', color: '#c76f8a' }), count: 360 },
      ],
      packing: 0.22,
      seed: 22,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'star-6': {
    label: 'hexagons + rods → 6-armed asterisks',
    config: {
      species: [
        { spec: () => hub({ n: 6, name: 'hexagon hub', color: '#8a7fb0' }), count: 60 },
        { spec: () => rod({ name: 'arm', color: '#d98b4a' }), count: 400 },
      ],
      packing: 0.22,
      seed: 23,
      params: { ...TUNED },
      schedule: { ...ANNEAL },
    },
  },
  'strut-net': {
    label: 'triangles + double-ended struts → network',
    config: {
      species: [
        { spec: () => hub({ n: 3, name: 'triangle hub', color: '#5fb0a5' }), count: 140 },
        // 4.6 wide rather than the hub's 5, for clearance. At equal width the
        // struts meet exactly at the hub's vertices, and a strut bonded at
        // both ends is pinned in the network and cannot relieve that
        // degenerate vertex contact — measured at 6.4x thermal equilibrium
        // with the charges switched *off*, so it was pure geometry. The small
        // gap takes it to 1.6x. The star presets keep the full width: their
        // arms bind at one end only and can always back off.
        {
          spec: () =>
            rod({ bothEnds: true, length: 12, width: 4.6, name: 'strut', color: '#e8b04b' }),
          count: 210,
        },
      ],
      packing: 0.22,
      seed: 24,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },

  // --- docking: concave binding sites ------------------------------------
  // A receptor with a V-notch cut into it, and a key whose tip fills it. The
  // notch makes the outline concave, so the rigid engine decomposes it into
  // convex collider pieces — without that the pocket fills in and nothing can
  // dock. + lines the notch and − sits on the key's flanks, so receptor-
  // receptor and key-key repel and the only bond is receptor-key.

  'dock-lock-key': {
    label: 'receptor + key → docked complexes',
    config: {
      species: [
        { spec: () => notchedBlock({ name: 'receptor', color: '#6c91bf' }), count: 120 },
        { spec: () => wedgeKey({ name: 'key', color: '#e8b04b' }), count: 160 },
      ],
      packing: 0.2,
      seed: 31,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },
  // Same chemistry on both keys — identical charges, identical flank lengths —
  // so any difference in binding is shape complementarity alone. The decoy's
  // wider apex cannot reach the notch walls, and a pose scan puts its best
  // interface at −28.8 against the matching key's −77.6.
  //
  // A ratio only discriminates at the right absolute scale. With the default
  // charge these interfaces are ~107 and ~32 energy units, so at the ring
  // presets' final kT=0.3 both are hundreds of kT and nothing ever lets go —
  // the first run bound decoys and matching keys equally (43% each). Rather
  // than heat until the integrator is out of its tested range, the charge is
  // scaled down here so the same ratio lands in a normal velocity regime:
  // at k=1.2 the interfaces are ~21 and ~6, and holding near kT≈2.2 leaves
  // the matching key at ~10 kT (holds) and the decoy at ~3 kT (lets go).
  // The run ends warm for the same reason — cooling further would just freeze
  // in whatever happened to be touching.
  'dock-selectivity': {
    label: 'right key vs wrong key',
    config: {
      species: [
        { spec: () => notchedBlock({ name: 'receptor', color: '#6c91bf' }), count: 120 },
        { spec: () => wedgeKey({ name: 'matching key', color: '#7fb069' }), count: 140 },
        {
          spec: () =>
            wedgeKey({ apexAngle: Math.PI / 2, name: 'decoy key', color: '#c76f8a' }),
          count: 140,
        },
      ],
      packing: 0.2,
      seed: 32,
      params: { ...TUNED, k: 1.2 },
      schedule: { Tstart: 3.5, Tend: 2.2, holdSteps: 80000, coolSteps: 40000 },
    },
  },
  'dock-chain': {
    label: 'notch + tip monomer → docked chains',
    config: {
      spec: () => dockingMonomer({ name: 'docking monomer', color: '#8a7fb0' }),
      count: 240,
      packing: 0.2,
      seed: 33,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },

  // --- three-component assemblies -----------------------------------------
  //
  // Two species can be told apart by charge *position* alone. Three cannot:
  // with every out-face + and every in-face −, any pairing already attracts and
  // moving charges around only weakens it (measured: wrong pairs still at
  // 60–85% of wanted). These use orthogonal *sign* patterns instead — see
  // KEY_SIGNS — which puts wrong pairings at 18% of wanted, and is checked by
  // test/keys.test.mjs.
  //
  // The three shapes are deliberately different, and the ring closes because
  // their turns sum correctly rather than because they match.
  //
  // Turn-sum closure is necessary but not sufficient, which cost a rebuild: the
  // first attempt paired a square, a hexagon and a 12-gon whose turns summed
  // perfectly to 2pi over six members — and whose two 12-gons then overlapped
  // by 5 units, because a 12-gon contributes only pi/6 of turn while being 19
  // units across. The ring was smaller than the molecules forming it, so it
  // could never assemble. Both scenarios below were picked by searching (n, k)
  // triples for turn-sum closure *and* clearance between non-adjacent members,
  // and test/geometry.test.mjs now checks both.
  'ternary-ring': {
    label: '12-gon + hexagon + 9-gon → strict 6-rings',
    config: {
      species: [
        { spec: () => keyedPolygon(12, 4, 0, 'dodecagon', '#e8b04b'), count: 44 },
        { spec: () => keyedPolygon(6, 2, 1, 'hexagon', '#6c91bf'), count: 44 },
        { spec: () => keyedPolygon(9, 3, 2, 'nonagon', '#7fb069'), count: 44 },
      ],
      // 0.4 rather than the usual 0.2: these are large shapes, and at 0.2 they
      // met too rarely to get past 5-member chains (60/132 bonded against
      // 103/132 here). Closure still does not happen — see the README.
      packing: 0.4,
      seed: 41,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },

  // A defined complex rather than a polymer: exactly one of each shape, closing
  // into a three-molecule ring. Turns of pi/2 + 2pi/3 + 5pi/6 make a full 2pi
  // in a single pass, so the assembly has nowhere to grow — it finishes at
  // three and stops, which is what a stoichiometric complex looks like.
  'ternary-trimer': {
    label: 'square + hexagon + 12-gon → 1:1:1 trimers',
    config: {
      species: [
        { spec: () => keyedPolygon(4, 1, 0, 'square', '#e8b04b'), count: 60 },
        { spec: () => keyedPolygon(6, 1, 1, 'hexagon', '#6c91bf'), count: 60 },
        { spec: () => keyedPolygon(12, 1, 2, 'dodecagon', '#c76f8a'), count: 60 },
      ],
      packing: 0.2,
      seed: 43,
      params: { ...TUNED },
      schedule: { ...LONG_ANNEAL },
    },
  },

  // Stoichiometric length control. A and B alternate into a straight rod
  // (n=6, k=3 turns by zero, so the chain never curls), and the cap carries the
  // same in-face as B — so it competes for an A end, binds, and stops that end
  // growing because it has no out-face of its own. Rod length is then set by
  // how much cap is present rather than by the shapes, which is the polymer
  // chemist's chain-transfer trick.
  'capped-rods': {
    label: 'A + B rods, terminated by a cap',
    config: {
      species: [
        { spec: () => keyedPolygon(6, 3, 0, 'rod A', '#e8b04b', 2), count: 110 },
        { spec: () => keyedPolygon(6, 3, 1, 'rod B', '#8a7fb0', 2), count: 110 },
        { spec: () => keyedCap(0, 2, 'cap', '#c76f8a'), count: 50 },
      ],
      packing: 0.2,
      seed: 42,
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
          count: 180,
        },
        {
          spec: () =>
            tiler({ n: 4, uniformSign: -1, chargeT: POLAR_T, name: 'square −', color: '#5fb0a5' }),
          count: 180,
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
