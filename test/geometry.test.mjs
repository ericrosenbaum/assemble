import {
  wedge,
  ringPose,
  polygonArea,
  facePair,
  tiler,
  facePairChain,
  mateNextPose,
  transformVerts,
  predictedAssembly,
} from '../src/shapes.js';

function transform(verts, pose) {
  const c = Math.cos(pose.angle);
  const s = Math.sin(pose.angle);
  return verts.map(([x, y]) => [pose.x + x * c - y * s, pose.y + x * s + y * c]);
}

let failures = 0;
function check(label, cond) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
}

for (const nRing of [6, 8, 12]) {
  const spec = wedge({ nRing });
  check(`wedge${nRing} is CCW`, polygonArea(spec.verts) > 0);

  // place all wedges in ring poses; wedge k's right side (edge 0: verts 0->1)
  // must coincide with wedge k+1's left side (edge 2: verts 2->3, reversed)
  const placed = [];
  for (let k = 0; k < nRing; k++) placed.push(transform(spec.verts, ringPose(spec, nRing, k)));
  let maxGap = 0;
  for (let k = 0; k < nRing; k++) {
    const a = placed[k];
    const b = placed[(k + 1) % nRing];
    // wedge k+1 sits CCW (to the left) of wedge k, so a's left side
    // (edge 2: a[2] outer-left -> a[3] inner-left) mates with b's right side
    // (edge 0: b[0] inner-right -> b[1] outer-right)
    maxGap = Math.max(
      maxGap,
      Math.hypot(a[3][0] - b[0][0], a[3][1] - b[0][1]),
      Math.hypot(a[2][0] - b[1][0], a[2][1] - b[1][1]),
    );
  }
  check(`wedge${nRing} ring closes flush (gap ${maxGap.toExponential(2)})`, maxGap < 1e-9);

  // mating charge sites must land at the same points with opposite signs:
  // wedge k's left face (edge 2) pairs with wedge k+1's right face (edge 0)
  const sites = spec.chargeSites();
  const edges = spec.charges.map((c) => c.edge);
  const placedSites = [];
  for (let k = 0; k < nRing; k++) {
    const pose = ringPose(spec, nRing, k);
    const c = Math.cos(pose.angle);
    const s = Math.sin(pose.angle);
    placedSites.push(sites.map(([x, y, q]) => [pose.x + x * c - y * s, pose.y + x * s + y * c, q]));
  }
  let maxChargeGap = 0;
  let signsOk = true;
  for (let k = 0; k < nRing; k++) {
    const A = placedSites[k].filter((_, i) => edges[i] === 2); // left face of wedge k
    const B = placedSites[(k + 1) % nRing].filter((_, i) => edges[i] === 0); // right face of k+1
    check(`wedge${nRing} equal site counts per face`, A.length === B.length && A.length > 0);
    for (const [ax, ay, aq] of A) {
      let best = Infinity;
      let bq = 0;
      for (const [bx, by, q2] of B) {
        const d = Math.hypot(ax - bx, ay - by);
        if (d < best) {
          best = d;
          bq = q2;
        }
      }
      maxChargeGap = Math.max(maxChargeGap, best);
      if (aq * bq >= 0 || Math.abs(aq + bq) > 1e-9) signsOk = false;
    }
  }
  check(
    `wedge${nRing} mating charges coincide (gap ${maxChargeGap.toExponential(2)})`,
    maxChargeGap < 1e-9,
  );
  check(`wedge${nRing} mating charges are equal and opposite`, signsOk);
}

// --- regular-polygon family: does m = 2n/(n-2k) actually predict closure? ---
//
// Build the chain by mating bonds one at a time (each step only asserts that
// two faces sit flush) and then ask whether molecule m lands back on molecule
// 0. Nothing here assumes a ring radius, so agreement is real evidence for
// the rule rather than a restatement of it.
console.log('\n-- regular-polygon assembly predictions --');
for (const [n, k, expect] of [
  [4, 1, 4], // square, adjacent faces -> 2x2 pinwheel
  [6, 1, 3], // hexagon -> trimer
  [6, 2, 6], // hexagon -> 6-ring
  [3, 1, 6], // triangle -> 6-membered rosette
  [5, 2, 10], // pentagon -> 10-ring
  [8, 3, 8], // octagon -> 8-ring
]) {
  const pred = predictedAssembly(n, k);
  check(`n=${n} k=${k}: rule predicts a ${expect}-ring`, pred.kind === 'ring' && pred.size === expect);

  const spec = facePair({ n, k });
  const m = pred.size;
  const poses = facePairChain(spec, m);

  // closing bond: mating onto the last molecule must reproduce molecule 0
  const closing = mateNextPose(spec, poses[m - 1]);
  const dPos = Math.hypot(closing.x - poses[0].x, closing.y - poses[0].y);
  const dAng = Math.abs(
    Math.atan2(Math.sin(closing.angle - poses[0].angle), Math.cos(closing.angle - poses[0].angle)),
  );
  check(
    `n=${n} k=${k}: ${m} copies close the ring (gap ${dPos.toExponential(2)}, ` +
      `angle ${dAng.toExponential(2)})`,
    dPos < 1e-9 && dAng < 1e-9,
  );

  // molecules must not overlap: every pair of centres at least an apothem apart
  let minSep = Infinity;
  for (let a = 0; a < m; a++) {
    for (let b = a + 1; b < m; b++) {
      minSep = Math.min(minSep, Math.hypot(poses[a].x - poses[b].x, poses[a].y - poses[b].y));
    }
  }
  const apothem = spec.boundingRadius() * Math.cos(Math.PI / n);
  check(`n=${n} k=${k}: ring has no self-overlap (min sep ${minSep.toFixed(2)})`, minSep > apothem);

  // mating charges must coincide with opposite sign
  const edges = spec.charges.map((c) => c.edge);
  const sites = spec.chargeSites();
  let maxGap = 0;
  let signsOk = true;
  for (let a = 0; a < m; a++) {
    const b = (a + 1) % m;
    const A = transformVerts(
      sites.map(([x, y]) => [x, y]),
      poses[a],
    );
    const B = transformVerts(
      sites.map(([x, y]) => [x, y]),
      poses[b],
    );
    for (let i = 0; i < sites.length; i++) {
      if (edges[i] !== k % n) continue; // our − face
      let best = Infinity;
      let bq = 0;
      for (let j = 0; j < sites.length; j++) {
        if (edges[j] !== 0) continue; // partner's + face
        const d = Math.hypot(A[i][0] - B[j][0], A[i][1] - B[j][1]);
        if (d < best) {
          best = d;
          bq = sites[j][2];
        }
      }
      maxGap = Math.max(maxGap, best);
      if (Math.abs(sites[i][2] + bq) > 1e-9) signsOk = false;
    }
  }
  check(`n=${n} k=${k}: mating charges coincide (gap ${maxGap.toExponential(2)})`, maxGap < 1e-9);
  check(`n=${n} k=${k}: mating charges are equal and opposite`, signsOk);
}

// opposite faces -> straight chain, never closes
for (const n of [4, 6, 8]) {
  const pred = predictedAssembly(n, n / 2);
  check(`n=${n} k=${n / 2}: predicted to run straight, not close`, pred.kind === 'chain');
  const spec = facePair({ n, k: n / 2 });
  const poses = facePairChain(spec, 5);
  // every molecule keeps the same orientation and centres stay collinear
  const sameAngle = poses.every(
    (p) => Math.abs(Math.atan2(Math.sin(p.angle), Math.cos(p.angle))) < 1e-9,
  );
  const dx = poses[1].x - poses[0].x;
  const dy = poses[1].y - poses[0].y;
  const collinear = poses.every((p, i) => Math.hypot(p.x - i * dx, p.y - i * dy) < 1e-9);
  check(`n=${n}: opposite-face chain stays aligned and straight`, sameAngle && collinear);
}

// non-integer m -> no closure predicted
check('n=5 k=1: no ring closes (10/3 is not an integer)', predictedAssembly(5, 1).kind === 'open');

// tilers: opposite faces must carry opposite charge, or the sheet can't bond
for (const n of [4, 6, 8]) {
  const spec = tiler({ n });
  const half = n / 2;
  let ok = true;
  for (let e = 0; e < n; e++) {
    const mine = spec.charges.filter((c) => c.edge === e);
    const opp = spec.charges.filter((c) => c.edge === (e + half) % n);
    if (!mine.length || !opp.length) ok = false;
    else if (Math.sign(mine[0].q) === Math.sign(opp[0].q)) ok = false;
  }
  check(`tiler n=${n}: opposite faces carry opposite charge`, ok);
}

if (failures > 0) {
  console.error(`${failures} failures`);
  process.exit(1);
}
console.log('all geometry tests passed');
