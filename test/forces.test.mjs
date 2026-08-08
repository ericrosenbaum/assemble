// The culled charge-force accumulator must reproduce the all-pairs reference
// exactly (up to float summation order). The culling bound is provably safe,
// so any real discrepancy means a dropped interaction — which would silently
// change the physics.

import { buildScenario } from '../src/presets.js';
import {
  accumulateChargeForces,
  accumulateChargeForcesCulled,
  buildMoleculeIndex,
  siteSpread,
} from '../src/sim/electrostatics.js';
import { makeRng } from '../src/rng.js';

let failures = 0;
function check(label, cond) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
}

// Build world-space charge sites for a set of poses, laid out contiguously
// per molecule (the layout both engines use).
function makeSites(spec, poses) {
  const local = spec.chargeSites();
  const per = local.length;
  const count = poses.length * per;
  const sites = {
    x: new Float64Array(count),
    y: new Float64Array(count),
    q: new Float64Array(count),
    mol: new Int32Array(count),
    count,
    nMol: poses.length,
  };
  let s = 0;
  poses.forEach((pose, mi) => {
    const c = Math.cos(pose.angle);
    const sn = Math.sin(pose.angle);
    for (const [lx, ly, q] of local) {
      sites.x[s] = pose.x + lx * c - ly * sn;
      sites.y[s] = pose.y + lx * sn + ly * c;
      sites.q[s] = q;
      sites.mol[s] = mi;
      s++;
    }
  });
  return sites;
}

const sc = buildScenario('wedge-8');
const spec = sc.specs[0];

// Sweep densities: sparse (culling rejects most pairs) through tightly packed
// (culling rejects almost nothing) so both branches are exercised.
for (const { label, box, count } of [
  { label: 'sparse', box: 160, count: 40 },
  { label: 'typical', box: 64, count: 32 },
  { label: 'dense', box: 34, count: 30 },
]) {
  const rng = makeRng(1234);
  const poses = [];
  for (let i = 0; i < count; i++) {
    poses.push({
      x: (rng.next() - 0.5) * box,
      y: (rng.next() - 0.5) * box,
      angle: rng.next() * Math.PI * 2,
    });
  }
  const sites = makeSites(spec, poses);
  const params = { ...sc.params };

  const refX = new Float64Array(sites.count);
  const refY = new Float64Array(sites.count);
  const culX = new Float64Array(sites.count);
  const culY = new Float64Array(sites.count);

  accumulateChargeForces(sites, params, refX, refY);
  const molIndex = buildMoleculeIndex(sites, poses.length, siteSpread(spec));
  accumulateChargeForcesCulled(sites, params, culX, culY, molIndex);

  let maxAbs = 0;
  let scale = 0;
  for (let i = 0; i < sites.count; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(refX[i] - culX[i]), Math.abs(refY[i] - culY[i]));
    scale = Math.max(scale, Math.abs(refX[i]), Math.abs(refY[i]));
  }
  const rel = scale > 0 ? maxAbs / scale : maxAbs;
  check(
    `${label} (n=${count}, box=${box}): culled matches reference ` +
      `(max|Δ|=${maxAbs.toExponential(2)}, rel=${rel.toExponential(2)})`,
    rel < 1e-12,
  );
  check(`${label}: forces are non-trivial (max|f|=${scale.toExponential(2)})`, scale > 0);
}

// Newton's third law: total force on an isolated system must vanish.
{
  const rng = makeRng(99);
  const poses = [];
  for (let i = 0; i < 24; i++) {
    poses.push({ x: (rng.next() - 0.5) * 50, y: (rng.next() - 0.5) * 50, angle: rng.next() * 7 });
  }
  const sites = makeSites(spec, poses);
  const fx = new Float64Array(sites.count);
  const fy = new Float64Array(sites.count);
  const molIndex = buildMoleculeIndex(sites, poses.length, siteSpread(spec));
  accumulateChargeForcesCulled(sites, { ...sc.params }, fx, fy, molIndex);
  let sx = 0;
  let sy = 0;
  let mag = 0;
  for (let i = 0; i < sites.count; i++) {
    sx += fx[i];
    sy += fy[i];
    mag = Math.max(mag, Math.abs(fx[i]), Math.abs(fy[i]));
  }
  check(
    `net force ~ 0 (|Σf|=${Math.hypot(sx, sy).toExponential(2)} vs max|f|=${mag.toExponential(2)})`,
    Math.hypot(sx, sy) / mag < 1e-12,
  );
}

// --- soft engine: cell-grid neighbour search must find exactly the pairs a
// brute-force all-pairs scan finds. A grid bug would silently drop
// interactions rather than crash.
{
  const { SoftEngineCPU } = await import('../src/sim/soft/cpu.js');
  const s2 = buildScenario('wedge-8', { count: 24, boxW: 52, boxH: 52 });
  const e = new SoftEngineCPU({
    specs: s2.specs,
    instances: s2.instances,
    box: s2.box,
    params: { ...s2.params, ...s2.paramsSoft },
    seed: 5,
    schedule: null,
  });
  // let it evolve so particles occupy many cells, including contacts
  e.params.kT = 1.5;
  for (let i = 0; i < 400; i++) e.step();

  const L = e.L;
  const p = e.params;
  e.computeForces();
  const gridFx = Float64Array.from(e.fx);
  const gridFy = Float64Array.from(e.fy);

  // brute-force reference: identical physics, no spatial acceleration
  const refFx = new Float64Array(L.n);
  const refFy = new Float64Array(L.n);
  for (let s = 0; s < L.sa.length; s++) {
    const i = L.sa[s];
    const j = L.sb[s];
    let dx = L.x[i] - L.x[j];
    let dy = L.y[i] - L.y[j];
    const d = Math.hypot(dx, dy) + 1e-12;
    dx /= d;
    dy /= d;
    const rel = (L.vx[i] - L.vx[j]) * dx + (L.vy[i] - L.vy[j]) * dy;
    const f = -p.kSpring * (d - L.sl[s]) - p.springDamp * rel;
    refFx[i] += f * dx;
    refFy[i] += f * dy;
    refFx[j] -= f * dx;
    refFy[j] -= f * dy;
  }
  const rc = p.sigma * Math.pow(2, 1 / 6);
  const rc2 = rc * rc;
  const sig2 = p.sigma * p.sigma;
  const cut2 = p.cutoff * p.cutoff;
  const soft2 = p.soft * p.soft;
  for (let i = 0; i < L.n; i++) {
    for (let j = i + 1; j < L.n; j++) {
      if (L.mol[i] === L.mol[j]) continue;
      const dx = L.x[i] - L.x[j];
      const dy = L.y[i] - L.y[j];
      const r2raw = dx * dx + dy * dy;
      if (!(L.q[i] * L.q[j] < 0) && r2raw <= rc2 && r2raw !== 0) {
        let r2 = r2raw < 0.49 * sig2 ? 0.49 * sig2 : r2raw;
        const inv2 = sig2 / r2;
        const inv6 = inv2 * inv2 * inv2;
        const fOverR = (24 * p.epsWCA * inv6 * (2 * inv6 - 1)) / r2;
        refFx[i] += fOverR * dx;
        refFy[i] += fOverR * dy;
        refFx[j] -= fOverR * dx;
        refFy[j] -= fOverR * dy;
      }
      if (L.q[i] !== 0 && L.q[j] !== 0 && r2raw <= cut2) {
        const r = Math.sqrt(r2raw);
        const rs = Math.sqrt(r2raw + soft2);
        const kq = p.k * L.q[i] * L.q[j] * Math.exp(-r / p.lambda);
        const f = -(kq * (-1 / (p.lambda * rs) - r / (rs * rs * rs))) / (r + 1e-12);
        refFx[i] += f * dx;
        refFy[i] += f * dy;
        refFx[j] -= f * dx;
        refFy[j] -= f * dy;
      }
    }
  }
  const kWall = 200;
  const hw = e.box.w / 2 - 1;
  const hh = e.box.h / 2 - 1;
  for (let i = 0; i < L.n; i++) {
    if (L.x[i] > hw) refFx[i] -= kWall * (L.x[i] - hw);
    else if (L.x[i] < -hw) refFx[i] -= kWall * (L.x[i] + hw);
    if (L.y[i] > hh) refFy[i] -= kWall * (L.y[i] - hh);
    else if (L.y[i] < -hh) refFy[i] -= kWall * (L.y[i] + hh);
  }

  let maxAbs = 0;
  let scale = 0;
  for (let i = 0; i < L.n; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(refFx[i] - gridFx[i]), Math.abs(refFy[i] - gridFy[i]));
    scale = Math.max(scale, Math.abs(refFx[i]), Math.abs(refFy[i]));
  }
  const rel = maxAbs / scale;
  check(
    `soft cell grid finds same pairs as brute force ` +
      `(${L.n} particles, max|Δ|=${maxAbs.toExponential(2)}, rel=${rel.toExponential(2)})`,
    rel < 1e-12,
  );
  check(`soft forces are non-trivial (max|f|=${scale.toExponential(2)})`, scale > 0);
}

if (failures > 0) {
  console.error(`${failures} failures`);
  process.exit(1);
}
console.log('all force tests passed');
