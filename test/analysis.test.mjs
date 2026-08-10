// The bond detector is spatially bucketed rather than all-pairs, so it needs
// the same treatment as the force kernel: prove it finds exactly the bonds a
// brute-force scan finds. A dropped bond would silently change every reported
// census — ring counts, cluster sizes, the per-species binding table — without
// failing anything else.

import { buildScenario } from '../src/presets.js';
import { RigidEngine } from '../src/sim/rigid/rapier.js';
import { bondGraph, clusters } from '../src/sim/analysis.js';

let failures = 0;
function check(label, cond) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
}

// same physics, no spatial acceleration
function bondGraphBrute(sites, { rBond = 0.8 } = {}) {
  const { x, y, q, mol, count } = sites;
  const r2 = rBond * rBond;
  const edges = new Set();
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (mol[i] === mol[j]) continue;
      if (q[i] * q[j] >= 0) continue;
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];
      if (dx * dx + dy * dy < r2) {
        const a = Math.min(mol[i], mol[j]);
        const b = Math.max(mol[i], mol[j]);
        edges.add(`${a}-${b}`);
      }
    }
  }
  return edges;
}

function edgeSet({ adj }) {
  const out = new Set();
  for (const [a, set] of adj) for (const b of set) if (a < b) out.add(`${a}-${b}`);
  return out;
}

// Cover assembled states (many bonds, dense contact) and early states (few
// bonds, molecules spread out) across single- and multi-species scenarios.
for (const name of ['wedge-8', 'square-2x2', 'dock-chain', 'star-3', 'salt-lattice']) {
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

  for (const steps of [200, 12000]) {
    while (e.stepCount < steps) e.step();
    const sites = e.chargeWorld();
    const fast = edgeSet(bondGraph(sites, e.params));
    const brute = bondGraphBrute(sites, e.params);
    const same = fast.size === brute.size && [...brute].every((k) => fast.has(k));
    check(
      `${name} @ ${steps} steps: bucketed bond graph matches brute force ` +
        `(${brute.size} bonds, ${sites.count} sites)`,
      same,
    );
  }

  // clusters() consumes the graph, so a malformed adjacency would show up here
  const comps = clusters(bondGraph(e.chargeWorld(), e.params));
  const total = comps.reduce((a, c) => a + c.length, 0);
  check(`${name}: clusters partition every molecule (${total} of ${e.bodies.length})`, total === e.bodies.length);
  e.free();
}

if (failures > 0) {
  console.error(`${failures} failures`);
  process.exit(1);
}
console.log('all analysis tests passed');
