// Convex decomposition has to be exact: the physics engine only sees the
// pieces, so anything the decomposition loses is a hole a molecule can fall
// through, and anything it adds is invisible material things bounce off.
//
// Area conservation is the test that matters — an early version of the merge
// step re-emitted a shared vertex and quietly lost 8% of the receptor's area
// while still producing convex-looking pieces.

import { decomposeConvex, isConvex, triangulate, signedArea } from '../src/geometry/decompose.js';
import { notchedBlock, wedgeKey, dockingMonomer, polygonArea } from '../src/shapes.js';

let failures = 0;
function check(label, cond) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${label}`);
  } else {
    console.log(`ok: ${label}`);
  }
}

const star = [];
for (let i = 0; i < 10; i++) {
  const a = (i * Math.PI) / 5;
  const r = i % 2 ? 3 : 7;
  star.push([r * Math.cos(a), r * Math.sin(a)]);
}
const comb = [
  [0, 0],
  [10, 0],
  [10, 4],
  [6, 4],
  [6, 2],
  [4, 2],
  [4, 4],
  [0, 4],
];
const uShape = [
  [0, 0],
  [9, 0],
  [9, 8],
  [6, 8],
  [6, 3],
  [3, 3],
  [3, 8],
  [0, 8],
];

const cases = [
  ['receptor (V-notch)', notchedBlock({}).verts, false],
  ['docking monomer', dockingMonomer({}).verts, false],
  ['key (already convex)', wedgeKey({}).verts, true],
  ['5-point star', star, false],
  ['comb', comb, false],
  ['U-shape', uShape, false],
];

for (const [name, poly, expectConvex] of cases) {
  check(`${name}: convexity detected correctly`, isConvex(poly) === expectConvex);

  const tris = triangulate(poly);
  check(`${name}: triangulated into n-2 triangles (${tris.length})`, tris.length === poly.length - 2);

  const pieces = decomposeConvex(poly);
  const area = Math.abs(polygonArea(poly));
  const sum = pieces.reduce((a, p) => a + Math.abs(polygonArea(p)), 0);
  check(
    `${name}: pieces conserve area (${area.toFixed(3)} vs ${sum.toFixed(3)})`,
    Math.abs(area - sum) < 1e-9,
  );
  check(`${name}: every piece is convex (${pieces.length} pieces)`, pieces.every(isConvex));
  check(`${name}: every piece is wound CCW`, pieces.every((p) => signedArea(p) > 0));
  check(`${name}: every piece has at least 3 vertices`, pieces.every((p) => p.length >= 3));
  // merging must actually reduce the piece count below raw triangulation
  if (!expectConvex) {
    check(`${name}: merging beat raw triangulation (${pieces.length} < ${tris.length})`, pieces.length < tris.length);
  }
}

// a convex polygon must pass through untouched, so existing presets are
// unaffected by the decomposition path
{
  const k = wedgeKey({}).verts;
  const pieces = decomposeConvex(k);
  check('convex input returns a single piece', pieces.length === 1);
  check(
    'convex input is returned unchanged',
    pieces[0].length === k.length && pieces[0].every((p, i) => Math.hypot(p[0] - k[i][0], p[1] - k[i][1]) < 1e-12),
  );
}

if (failures > 0) {
  console.error(`${failures} failures`);
  process.exit(1);
}
console.log('all decomposition tests passed');
