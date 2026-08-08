import { wedge, ringPose, polygonArea } from '../src/shapes.js';

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

if (failures > 0) {
  console.error(`${failures} failures`);
  process.exit(1);
}
console.log('all geometry tests passed');
