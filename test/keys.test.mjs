// Three-or-more-species assemblies live or die on interface specificity, so
// it gets measured rather than asserted by construction.
//
// Every ordered pair of species is mated face-to-face at the geometry the
// assembly predicts and the electrostatic energy across the interface totalled.
// The intended pairs must be strongly bound, comparable to each other (three
// interfaces of very different strength cannot share one temperature), and much
// stronger than any wrong pairing.

import { facePair, keyCycle, KEY_SIGNS, mateNextPose } from '../src/shapes.js';
import { pairEnergy } from '../src/sim/electrostatics.js';
import { buildScenario } from '../src/presets.js';

let failures = 0;
function check(label, cond) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
}

const params = buildScenario('wedge-8').params;
const names = ['A', 'B', 'C'];
const specs = names.map((nm, i) => {
  const k = keyCycle(i);
  return facePair({ n: 6, k: 2, q: 0.8, chargeT: k.outT, chargeTk: k.inT, signs: [k.outQ, k.inQ], name: nm });
});

function sites(spec, pose) {
  const c = Math.cos(pose.angle);
  const s = Math.sin(pose.angle);
  return spec.chargeSites().map(([x, y, q]) => [pose.x + x * c - y * s, pose.y + x * s + y * c, q]);
}

// `partner` docks its out-face onto `host`'s in-face
function interfaceEnergy(host, partner) {
  const hp = { x: 0, y: 0, angle: 0 };
  const a = sites(host, hp);
  const b = sites(partner, mateNextPose(host, hp, partner));
  let e = 0;
  for (const [x1, y1, q1] of a) for (const [x2, y2, q2] of b) e += pairEnergy(x1 - x2, y1 - y2, q1 * q2, params);
  return e;
}

const wanted = [];
const wrong = [];
for (let h = 0; h < 3; h++) {
  for (let p = 0; p < 3; p++) {
    const e = interfaceEnergy(specs[h], specs[p]);
    // host h's in-face carries the complement of key h-1, so it wants h-1
    (p === (h + 2) % 3 ? wanted : wrong).push({ h, p, e });
  }
}

const weakestWanted = Math.max(...wanted.map((w) => w.e)); // least negative
const strongestWrong = Math.min(...wrong.map((w) => w.e));
const ratio = strongestWrong / weakestWanted;

check(
  `every intended interface binds (weakest ${weakestWanted.toFixed(1)})`,
  weakestWanted < -35,
);
check(
  `intended interfaces are comparable (spread ${(
    Math.min(...wanted.map((w) => w.e)) / weakestWanted
  ).toFixed(2)}x)`,
  Math.min(...wanted.map((w) => w.e)) / weakestWanted < 1.3,
);
check(
  `wrong pairings are weak (strongest ${strongestWrong.toFixed(1)}, ` +
    `${(ratio * 100).toFixed(0)}% of weakest wanted)`,
  ratio < 0.35,
);

// The sign patterns are what buys the specificity, so pin their two properties
// directly: mutual orthogonality, and being the negative of their own reverse
// (which is what makes a back-to-front join repel instead of bind).
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
let orth = true;
let antipal = true;
for (let i = 0; i < KEY_SIGNS.length; i++) {
  if (dot(KEY_SIGNS[i], [...KEY_SIGNS[i]].reverse()) >= 0) antipal = false;
  for (let j = i + 1; j < KEY_SIGNS.length; j++) if (dot(KEY_SIGNS[i], KEY_SIGNS[j]) !== 0) orth = false;
}
check('key sign patterns are mutually orthogonal', orth);
check('each key pattern is the negative of its reverse (reversed joins repel)', antipal);

if (failures > 0) {
  console.error(`${failures} failures`);
  process.exit(1);
}
console.log('all key-specificity tests passed');
