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
    if (out[k] != null) out[k] = Math.max(1, Math.round(out[k] * f));
  }
  return out;
}

function defaultVariants() {
  const v = [];
  v.push({ name: 'baseline anneal', cfg: { ...BASE } });

  // Never cool at all. A first pass found yield climbing monotonically with
  // temperature all the way to the preset's hot rail (1.7), so this sweep
  // deliberately continues past it to find where it turns over.
  for (const T of [1.2, 1.4, 1.6, 1.8, 2.0, 2.3, 2.7]) {
    v.push({ name: `steady T=${T}`, cfg: { mode: 'steady', Tstart: T } });
  }

  // hold-then-cool with different hold lengths (is the long hot hold useful?)
  for (const hold of [0, 70000, 105000, 122000]) {
    v.push({ name: `anneal hold=${hold}`, cfg: { ...BASE, holdSteps: hold, coolSteps: 130000 - hold } });
  }

  // Cycling that never goes cold. The first pass found that plunging to 0.3 or
  // 0.9 destroyed ring yield outright — every such variant finished with zero
  // correct rings, because the cold phase freezes in disorder faster than the
  // hot phase can melt it out. These oscillate inside the productive band.
  for (const period of [6000, 20000]) {
    for (const [hot, cold] of [
      [2.0, 1.4],
      [2.3, 1.5],
      [2.6, 1.6],
    ]) {
      v.push({
        name: `cycle ${hot}/${cold} period=${period}`,
        cfg: { mode: 'cycle', Thot: hot, Tcold: cold, periodSteps: period, holdSteps: 6000, coolSteps: 0 },
      });
    }
  }

  // Control: the cold-plunge kind, so the warm-band cycles have something
  // other than the steady runs to beat.
  v.push({
    name: 'cycle 1.7/0.6 period=20000',
    cfg: { mode: 'cycle', Thot: 1.7, Tcold: 0.6, periodSteps: 20000, holdSteps: 6000, coolSteps: 0 },
  });

  // A slow ramp that ends warm rather than cold.
  v.push({ name: 'ramp 2.4->1.6', cfg: { Tstart: 2.4, Tend: 1.6, holdSteps: 10000, coolSteps: 120000 } });
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
  const CHECK = Math.max(1000, Math.round(steps / 40));
  for (let i = 0; i < steps; i++) {
    e.step();
    if (i % CHECK !== 0) continue;
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
  e.free();
  return { correct, survived, rings: rings.length, bonded, n: sc.instances.length, peak: best, firstHit };
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
    firstHit: mean((r) => r.firstHit ?? steps),
  };
  rows.push(row);
  console.log(
    `${row.name.padEnd(30)} quenched=${row.correct.toFixed(1).padStart(5)}  ` +
      `survived=${row.survived.toFixed(1).padStart(5)}  ` +
      `allRings=${row.rings.toFixed(1).padStart(5)}  purity=${(row.purity * 100).toFixed(0).padStart(3)}%  ` +
      `bonded=${(row.bondedPct * 100).toFixed(0).padStart(3)}%  reachedAt=${Math.round(row.firstHit)}`,
  );
}

if (args.json) fs.writeFileSync(args.json, JSON.stringify({ scenario, count, steps, seeds, target, rows }, null, 2));
console.log('\n--- ranked by correct-size rings after an identical quench ---');
for (const r of [...rows].sort((a, b) => b.correct - a.correct)) {
  console.log(`  ${r.correct.toFixed(1).padStart(5)}  ${r.name}`);
}
