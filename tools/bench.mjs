// Engine throughput benchmark. Runs the real engine step() in Node, so it
// measures what the app and the headless capture harness actually execute.
//
//   node tools/bench.mjs                 # both engines, default sizes
//   node tools/bench.mjs --engine rigid --counts 32,100,300
//   node tools/bench.mjs --json out.json # machine-readable, for before/after

import fs from 'node:fs';
import { buildScenario } from '../src/presets.js';
import { RigidEngine } from '../src/sim/rigid/rapier.js';
import { SoftEngineCPU } from '../src/sim/soft/cpu.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const which = args.engine ?? 'both';
const now = () => Number(process.hrtime.bigint()) / 1e6;

// Box scales with count so density (and therefore neighbour counts) stays
// comparable across sizes — otherwise bigger N would also mean denser packing
// and the numbers wouldn't be a clean scaling measurement.
const boxFor = (count) => Math.round(Math.sqrt(count) * 11.3);

function makeEngine(Cls, count, extraParams = {}) {
  const box = boxFor(count);
  const sc = buildScenario('wedge-8', { count, boxW: box, boxH: box });
  const e = new Cls({
    specs: sc.specs,
    instances: sc.instances,
    box: sc.box,
    params: { ...sc.params, ...extraParams },
    seed: 7,
    schedule: null,
  });
  return { e, sc };
}

async function benchRigid(count) {
  const { e } = makeEngine(RigidEngine, count);
  await e.ready;
  for (let i = 0; i < 100; i++) e.step(); // warm JIT + let bodies settle
  const steps = count >= 300 ? 200 : 1000;
  const t = now();
  for (let i = 0; i < steps; i++) e.step();
  const ms = now() - t;
  const sites = e.sites.count;
  e.free();
  return { engine: 'rigid', count, sites, stepsPerSec: Math.round(steps / (ms / 1000)) };
}

function benchSoft(count) {
  const { e, sc } = makeEngine(SoftEngineCPU, count, {});
  Object.assign(e.params, sc.paramsSoft);
  for (let i = 0; i < 20; i++) e.step();
  const steps = count >= 64 ? 40 : 120;
  const t = now();
  for (let i = 0; i < steps; i++) e.step();
  const ms = now() - t;
  return {
    engine: 'soft',
    count,
    particles: e.L.n,
    substeps: e.params.substeps,
    stepsPerSec: Math.round(steps / (ms / 1000)),
  };
}

const results = [];
if (which === 'rigid' || which === 'both') {
  const counts = (args.counts ?? '32,100,300').split(',').map(Number);
  for (const c of counts) results.push(await benchRigid(c));
}
if (which === 'soft' || which === 'both') {
  const counts = (args.counts ?? '16,32,64').split(',').map(Number);
  for (const c of counts) results.push(benchSoft(c));
}

for (const r of results) {
  const detail =
    r.engine === 'rigid'
      ? `sites=${String(r.sites).padStart(4)}`
      : `particles=${String(r.particles).padStart(4)} substeps=${r.substeps}`;
  console.log(
    `${r.engine.padEnd(5)} n=${String(r.count).padStart(3)} ${detail}  ${String(r.stepsPerSec).padStart(6)} steps/s`,
  );
}

if (args.json) {
  fs.writeFileSync(args.json, JSON.stringify(results, null, 2));
  console.log(`wrote ${args.json}`);
}
