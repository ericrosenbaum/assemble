// Which annealing protocol actually assembles best?
//
// "Cool slowly from hot" is the folk rule, and every preset here inherited it
// without ever being compared against the alternatives. The plausible rivals:
//
//   - a steady moderate temperature (never cool at all)
//   - a steady high temperature (fast kinetics, weak structures)
//   - cycling hot/cold, so mistakes get repeated chances to melt out while
//     correct structure — being more strongly bound — survives each hot phase
//
// Scored on what actually matters: how many rings of the *correct* size exist
// at the end, not how many rings of any size. A protocol that produces twice
// as many 7- and 9-rings is worse, not better.
//
//   node tools/anneal_search.mjs --scenario wedge-8 --count 120 --steps 60000
//   node tools/anneal_search.mjs --shard 0/3        # split across processes
//   node tools/anneal_search.mjs --variants custom.json

import fs from 'node:fs';
import { buildScenario } from '../src/presets.js';
import { RigidEngine } from '../src/sim/rigid/rapier.js';
import { TemperatureSchedule } from '../src/sim/engine.js';
import { bondGraph, clusters, countRings } from '../src/sim/analysis.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];

const scenario = args.scenario ?? 'wedge-8';
const count = Number(args.count ?? 120);
const steps = Number(args.steps ?? 60000);
const seeds = (args.seeds ?? '1,2,3').split(',').map(Number);
const target = Number(args.target ?? 8); // ring size that counts as correct
const [shardI, shardN] = (args.shard ?? '0/1').split('/').map(Number);

// The baseline is the schedule the presets actually ship, so every number here
// is relative to what we already do.
const BASE = { Tstart: 1.7, Tend: 0.3, holdSteps: 70000, coolSteps: 35000 };

function scaled(o) {
  // Schedules are written in steps for a 130k-step run; rescale to the search
  // budget so a shorter run isn't secretly a different protocol.
  const f = steps / 130000;
  const out = { ...o };
  for (const k of ['holdSteps', 'coolSteps', 'periodSteps']) {
    // Zero is meaningful — `coolSteps: 0` is how a cycle says "no downward
    // drift". Clamping it to 1 made the drift term complete on the first step
    // and multiplied both rails by Tend/Thot, so every cycling variant silently
    // ran at T ~ 0.1 and froze. Only round a positive value up to 1.
    if (out[k]) out[k] = Math.max(1, Math.round(out[k] * f));
  }
  return out;
}

function defaultVariants() {
  const v = [];
  v.push({ name: 'baseline anneal', cfg: { ...BASE } });

  // Never cool at all. Earlier passes found yield climbing with temperature
  // well past the preset's hot rail (1.7), so this continues up to find where
  // it turns over.
  for (const T of [1.7, 2.0, 2.3, 2.7, 3.2]) {
    v.push({ name: `steady T=${T}`, cfg: { mode: 'steady', Tstart: T } });
  }

  // Is the cooling phase worth anything, and how long should the hot hold be?
  for (const hold of [105000]) {
    v.push({ name: `anneal hold=${hold}`, cfg: { ...BASE, holdSteps: hold, coolSteps: 130000 - hold } });
  }

  // Cycling within the productive band, plus one cold-plunge control.
  for (const [hot, cold, period] of [
    [2.3, 1.5, 6000],
    [2.3, 1.5, 20000],
    [2.8, 1.6, 20000],
    [2.3, 0.6, 20000],
  ]) {
    v.push({
      name: `cycle ${hot}/${cold} period=${period}`,
      cfg: { mode: 'cycle', Thot: hot, Tcold: cold, periodSteps: period, holdSteps: 6000, coolSteps: 0 },
    });
  }

  // A slow ramp that ends warm rather than cold.
  v.push({ name: 'ramp 2.7->1.7', cfg: { Tstart: 2.7, Tend: 1.7, holdSteps: 10000, coolSteps: 120000 } });
  return v;
}

const variants = args.variants ? JSON.parse(fs.readFileSync(args.variants, 'utf8')) : defaultVariants();

async function run(cfg, seed) {
  const sc = buildScenario(scenario, { count, seed });
  const e = new RigidEngine({
    specs: sc.specs, instances: sc.instances, box: sc.box,
    params: sc.params, seed, schedule: new TemperatureSchedule(scaled(cfg)),
  });
  await e.ready;

  let firstHit = null; // step at which correct-ring count first reaches its final value
  let best = 0;
  // Hot variants can push the explicit integrator past what dt supports, and a
  // run that is quietly blowing up would otherwise just score badly and look
  // like a bad protocol. Track kinetic energy against the Langevin equilibrium
  // for the temperature in force, so overheating is reported, not inferred.
  let peakKE = 0;
  const CHECK = Math.max(1000, Math.round(steps / 40));
  // Molecules are scattered without a full overlap check, so the opening
  // moments contain a harmless contact transient. Sampling through it reported
  // 6.8x equilibrium for a preset that measures 1.1x once running — a startup
  // spike read as an integrator failure. Same trap as test/stability.test.mjs,
  // which already skips it.
  const SETTLE = Math.max(CHECK, Math.round(steps * 0.05));
  for (let i = 0; i < steps; i++) {
    e.step();
    if (i < SETTLE || i % CHECK !== 0) continue;
    let ke = 0;
    for (let m = 0; m < e.bodies.length; m++) {
      const v = e.bodies[m].linvel();
      const w = e.bodies[m].angvel();
      ke += 0.5 * e._mass[m] * (v.x * v.x + v.y * v.y) + 0.5 * e._inertia[m] * w * w;
    }
    peakKE = Math.max(peakKE, ke / (1.5 * e.bodies.length * e.params.kT));
    const n = countRings(bondGraph(e.chargeWorld(), e.params)).filter((r) => r === target).length;
    if (n > best) {
      best = n;
      firstHit = i;
    }
  }

  // Every protocol gets the same ending, or the comparison is rigged: a
  // steady-hot run would otherwise be scored while still hot (where rings
  // constantly form and break) and an annealed run while already frozen.
  //
  // Two numbers, both after the protocol proper has finished:
  //   survived — hold at whatever temperature the protocol ended at, so a
  //              structure that only exists while cold does not count
  //   quenched — then cool everything to the same cold temperature, which is
  //              "what you would get if you froze it right now"
  const holdT = e.params.kT;
  e.schedule = null;
  e.params.kT = holdT;
  const holdSteps = Math.round(steps * 0.15);
  for (let i = 0; i < holdSteps; i++) e.step();
  const survived = countRings(bondGraph(e.chargeWorld(), e.params)).filter((r) => r === target).length;

  const quench = Math.round(steps * 0.12);
  for (let i = 0; i < quench; i++) {
    e.params.kT = holdT * Math.pow(0.3 / holdT, (i + 1) / quench);
    e.step();
  }
  for (let i = 0; i < Math.round(steps * 0.05); i++) e.step();

  const g = bondGraph(e.chargeWorld(), e.params);
  const rings = countRings(g);
  const correct = rings.filter((r) => r === target).length;
  const comps = clusters(g);
  const bonded = comps.filter((c) => c.length > 1).reduce((a, c) => a + c.length, 0);
  // Kinetic trapping shows up as molecules locked into clusters that are large
  // enough to be committed but are not finished structures — a half-ring wedged
  // against a neighbour it cannot get past. Count molecules in clusters of 3+
  // that contain no correct-size ring: that is the population a hotter or
  // spiked protocol is supposed to free up.
  const ringMembers = new Set();
  for (const c of comps) if (c.length === target) for (const m of c) ringMembers.add(m);
  const trapped = comps
    .filter((c) => c.length >= 3 && !c.every((m) => ringMembers.has(m)))
    .reduce((a, c) => a + c.length, 0);
  e.free();
  return {
    correct, survived, rings: rings.length, bonded, trapped,
    n: sc.instances.length, peak: best, firstHit, peakKE,
  };
}

const rows = [];
for (let vi = 0; vi < variants.length; vi++) {
  if (vi % shardN !== shardI) continue;
  const v = variants[vi];
  const runs = [];
  for (const seed of seeds) runs.push(await run(v.cfg, seed));
  const mean = (f) => runs.reduce((a, r) => a + f(r), 0) / runs.length;
  const row = {
    name: v.name,
    cfg: v.cfg,
    correct: mean((r) => r.correct),
    survived: mean((r) => r.survived),
    rings: mean((r) => r.rings),
    purity: mean((r) => (r.rings ? r.correct / r.rings : 0)),
    bondedPct: mean((r) => r.bonded / r.n),
    trappedPct: mean((r) => r.trapped / r.n),
    peakKE: mean((r) => r.peakKE),
    firstHit: mean((r) => r.firstHit ?? steps),
  };
  rows.push(row);
  console.log(
    `${row.name.padEnd(30)} quenched=${row.correct.toFixed(1).padStart(5)}  ` +
      `survived=${row.survived.toFixed(1).padStart(5)}  ` +
      `allRings=${row.rings.toFixed(1).padStart(5)}  purity=${(row.purity * 100).toFixed(0).padStart(3)}%  ` +
      `trapped=${(row.trappedPct * 100).toFixed(0).padStart(3)}%  ` +
      `peakKE=${row.peakKE.toFixed(1)}x  reachedAt=${Math.round(row.firstHit)}`,
  );
}

if (args.json) fs.writeFileSync(args.json, JSON.stringify({ scenario, count, steps, seeds, target, rows }, null, 2));
console.log('\n--- ranked by correct-size rings after an identical quench ---');
for (const r of [...rows].sort((a, b) => b.correct - a.correct)) {
  console.log(`  ${r.correct.toFixed(1).padStart(5)}  ${r.name}`);
}
