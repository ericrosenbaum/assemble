// Every preset must stay near thermal equilibrium.
//
// A Langevin thermostat holds a 2D rigid body at 1.5*kT of kinetic energy
// (two translational plus one rotational degree of freedom). If a preset's
// forces are too stiff for its timestep, the explicit integration pumps energy
// in and the run heats up — structures shudder and then burst apart.
//
// This is the check that was missing when docked chains flew apart: the bug
// was visible only by watching, and every other test passed. Running the whole
// SCENARIOS table means a new preset with stronger charges gets caught here
// instead of being noticed in a movie.

import { SCENARIOS, buildScenario } from '../src/presets.js';
import { RigidEngine } from '../src/sim/rigid/rapier.js';

const STEPS = Number(process.env.STEPS ?? 25000);
// Molecules are scattered without a full overlap check, so the first moments
// contain a harmless contact transient as they push apart. Measuring through
// it flagged presets whose peak was at step 0 — a startup spike, not heating.
const SETTLE = 2000;
// Generous: thermostats fluctuate and assembly releases binding energy as
// heat. Anything genuinely unstable runs many times hotter than this.
const LIMIT = 4;

let failures = 0;
const rows = [];

for (const name of Object.keys(SCENARIOS)) {
  const sc = buildScenario(name);
  const e = new RigidEngine({
    specs: sc.specs,
    instances: sc.instances,
    box: sc.box,
    params: sc.params,
    seed: sc.seed,
    schedule: sc.schedule,
  });
  await e.ready;

  let peak = 0;
  let peakRatio = 0;
  let diverged = false;
  for (let i = 0; i < STEPS; i++) {
    e.step();
    if (i < SETTLE || i % 50 !== 0) continue;
    let ke = 0;
    for (let m = 0; m < e.bodies.length; m++) {
      const v = e.bodies[m].linvel();
      const w = e.bodies[m].angvel();
      if (!Number.isFinite(v.x) || !Number.isFinite(w)) {
        diverged = true;
        break;
      }
      ke += 0.5 * e._mass[m] * (v.x * v.x + v.y * v.y) + 0.5 * e._inertia[m] * w * w;
    }
    if (diverged) break;
    // equilibrium tracks the annealing schedule, so compare against the
    // temperature in force at this moment
    const equilibrium = 1.5 * e.bodies.length * e.params.kT;
    peak = Math.max(peak, ke);
    peakRatio = Math.max(peakRatio, ke / equilibrium);
  }
  e.free();

  const ok = !diverged && peakRatio <= LIMIT;
  if (!ok) failures++;
  rows.push({ name, peakRatio, diverged, ok });
  console.log(
    `${ok ? 'ok  ' : 'FAIL'}: ${name.padEnd(18)} peak KE = ${peakRatio.toFixed(1).padStart(5)}x equilibrium` +
      (diverged ? '   DIVERGED (non-finite)' : ''),
  );
}

const worst = rows.filter((r) => r.ok).sort((a, b) => b.peakRatio - a.peakRatio)[0];
if (worst) console.log(`\nleast headroom: ${worst.name} at ${worst.peakRatio.toFixed(1)}x (limit ${LIMIT}x)`);

if (failures > 0) {
  console.error(`\n${failures} preset(s) are heating up — forces too stiff for the timestep`);
  process.exit(1);
}
console.log('all presets thermally stable');
