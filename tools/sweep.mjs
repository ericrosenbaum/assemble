// Parameter sweep scored on *time to assembly*, not steps/s.
//
// A bigger dt makes every step cheaper in wall-clock but covers more
// simulated time per step, so raw throughput is the wrong scoreboard: what
// matters is how long until rings actually appear, and whether they still
// appear at all. This runs each configuration across several seeds and
// reports ring yield, median steps-to-first-ring, and wall-clock seconds.
//
//   node tools/sweep.mjs                       # default dt sweep
//   node tools/sweep.mjs --dts 0.008333,0.0125 --seeds 1,2,3 --steps 120000

import { buildScenario } from '../src/presets.js';
import { RigidEngine } from '../src/sim/rigid/rapier.js';
import { TemperatureSchedule } from '../src/sim/engine.js';
import { stats } from '../src/sim/analysis.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const seeds = (args.seeds ?? '1,2,3').split(',').map(Number);
const dts = (args.dts ?? '0.008333,0.0125,0.016667').split(',').map(Number);
const baseSteps = Number(args.steps ?? 150000);

// The schedule is in steps, so a larger dt must use proportionally fewer
// steps to anneal over the same simulated time — otherwise a dt change would
// silently also be a schedule change and the comparison would be meaningless.
const REF_DT = 1 / 120;
const OVERRIDES = {
  count: 40,
  boxW: 76,
  boxH: 76,
  params: { k: 6, lambda: 1.4, soft: 0.5, gamma: 0.3, cutoff: 9, friction: 0.1, restitution: 0.05 },
};
const REF_SCHEDULE = { Tstart: 1.7, Tend: 0.7, holdSteps: 120000, coolSteps: 60000 };

async function run(dt, seed) {
  const scale = REF_DT / dt;
  const steps = Math.round(baseSteps * scale);
  const schedule = new TemperatureSchedule({
    Tstart: REF_SCHEDULE.Tstart,
    Tend: REF_SCHEDULE.Tend,
    holdSteps: Math.round(REF_SCHEDULE.holdSteps * scale),
    coolSteps: Math.round(REF_SCHEDULE.coolSteps * scale),
  });
  const sc = buildScenario('wedge-8', { ...OVERRIDES, seed });
  const e = new RigidEngine({
    specs: sc.specs,
    instances: sc.instances,
    box: sc.box,
    params: { ...sc.params, dt },
    seed,
    schedule,
  });
  await e.ready;

  let firstRing = null;
  let blewUp = false;
  const checkEvery = Math.max(500, Math.round(1000 * scale));
  const t0 = Date.now();
  for (let i = 0; i < steps; i++) {
    e.step();
    if (i % checkEvery === 0 && i > 0) {
      // a diverging integrator flings molecules far outside the box
      const p = e.poses()[0];
      if (!Number.isFinite(p.x) || Math.abs(p.x) > sc.box.w * 5) {
        blewUp = true;
        break;
      }
      if (firstRing === null && stats(e.chargeWorld()).rings.length > 0) firstRing = i;
    }
  }
  const st = blewUp ? { rings: [], largest: 0, bonded: 0 } : stats(e.chargeWorld());
  const secs = (Date.now() - t0) / 1000;
  e.free();
  return { dt, seed, steps, rings: st.rings, largest: st.largest, firstRing, secs, blewUp };
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

console.log(`sweep: ${seeds.length} seeds x ${dts.length} dt values, ${baseSteps} steps at dt=1/120\n`);
for (const dt of dts) {
  const rows = [];
  for (const seed of seeds) rows.push(await run(dt, seed));
  const ok = rows.filter((r) => !r.blewUp);
  const withRing = ok.filter((r) => r.rings.length > 0);
  const firsts = ok.map((r) => r.firstRing).filter((v) => v !== null);
  // steps-to-first-ring is only comparable across dt once converted to
  // simulated time
  const simTime = firsts.length ? median(firsts) * dt : null;
  console.log(
    `dt=1/${Math.round(1 / dt).toString().padStart(3)} steps=${rows[0].steps} | ` +
      `rings in ${withRing.length}/${rows.length} seeds, ` +
      `${rows.reduce((a, r) => a + r.rings.length, 0)} total | ` +
      `mean largest ${mean(ok.map((r) => r.largest)).toFixed(1)} | ` +
      `median t-to-ring ${simTime ? simTime.toFixed(1) + ' sim-s' : '-'} | ` +
      `mean wall ${mean(rows.map((r) => r.secs)).toFixed(1)}s` +
      (rows.some((r) => r.blewUp) ? `  UNSTABLE (${rows.filter((r) => r.blewUp).length})` : ''),
  );
}
