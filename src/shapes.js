// Molecule shape + charge specification.
//
// A MoleculeSpec is a convex CCW polygon (local coordinates, centroid at
// origin) plus a list of charge sites. Each charge site lives on an edge:
//   { edge: i, t: 0..1, q: signed magnitude }
// where the site position is verts[i] + t * (verts[i+1] - verts[i]).

export function polygonArea(verts) {
  let a = 0;
  for (let i = 0; i < verts.length; i++) {
    const [x1, y1] = verts[i];
    const [x2, y2] = verts[(i + 1) % verts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function polygonCentroid(verts) {
  let cx = 0;
  let cy = 0;
  let a = 0;
  for (let i = 0; i < verts.length; i++) {
    const [x1, y1] = verts[i];
    const [x2, y2] = verts[(i + 1) % verts.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  a /= 2;
  return [cx / (6 * a), cy / (6 * a)];
}

export class MoleculeSpec {
  constructor({ name = 'molecule', verts, charges = [], color = null }) {
    // recenter so centroid is at local origin (body poses then refer to centroid)
    const [cx, cy] = polygonCentroid(verts);
    this.name = name;
    this.verts = verts.map(([x, y]) => [x - cx, y - cy]);
    if (polygonArea(this.verts) < 0) {
      this.verts.reverse();
      // edge indices flip meaning if we reverse; charges must be given for CCW polys
    }
    this.charges = charges;
    this.color = color;
  }

  // local-space positions of the charge sites: [[x, y, q], ...]
  chargeSites() {
    const n = this.verts.length;
    return this.charges.map(({ edge, t, q }) => {
      const [x1, y1] = this.verts[edge % n];
      const [x2, y2] = this.verts[(edge + 1) % n];
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1), q];
    });
  }

  area() {
    return polygonArea(this.verts);
  }

  // bounding radius from centroid (for neighbor-list cutoffs)
  boundingRadius() {
    let r = 0;
    for (const [x, y] of this.verts) r = Math.max(r, Math.hypot(x, y));
    return r;
  }

  toJSON() {
    return { name: this.name, verts: this.verts, charges: this.charges, color: this.color };
  }

  static fromJSON(obj) {
    return new MoleculeSpec(obj);
  }
}

// Wedge preset: a trapezoid that is one segment of an nRing-membered ring
// (like a tubulin monomer in a microtubule cross-section).
//
// Built in "ring coordinates": the ring center is at the origin, the wedge
// points radially along +y. The two sloped sides lie on rays at angles
// ±(π/nRing) from center, so nRing copies rotated by 2π/nRing mate flush
// and close into a ring. Charge sites sit on the sloped sides: +q on the
// right side, −q on the left, mirrored so mating faces align charge-to-charge.
export function wedge({
  nRing = 8,
  rInner = 4,
  rOuter = 9,
  chargesPerSide = 3,
  q = 1,
  // Asymmetric layout (positions measured inner->outer along the sloped
  // side, with per-site magnitudes). A wedge flipped 180° presents its
  // charges mirrored about the face midpoint, so a symmetric layout binds
  // zigzag (flipped) joints exactly as strongly as correct ones. Clustering
  // the charges toward the inner edge with decaying magnitudes makes flipped
  // binding much weaker, so zigzag defects anneal away. Pass null for both
  // to get the classic evenly-spaced ±q layout from the 2005 article.
  // Default layout: equal charges at Golomb-ruler positions (all pairwise
  // spacings distinct). Two flip symmetries protect assembly: a 180°-flipped
  // wedge presents its like-signed face (purely repulsive — zigzag joints
  // can't form), and a slid face aligns at most ONE charge pair (weak,
  // breaks thermally) while flush mating aligns all of them.
  chargeT = [0.2, 0.45, 0.8],
  chargeQ = [1.0, 1.0, 1.0],
  name = null,
} = {}) {
  const alpha = Math.PI / nRing;
  const s = Math.sin(alpha);
  const c = Math.cos(alpha);
  // CCW order: inner-right, outer-right, outer-left, inner-left
  const verts = [
    [rInner * s, rInner * c],
    [rOuter * s, rOuter * c],
    [-rOuter * s, rOuter * c],
    [-rInner * s, rInner * c],
  ];
  if (!chargeT) chargeT = Array.from({ length: chargesPerSide }, (_, i) => (i + 1) / (chargesPerSide + 1));
  if (!chargeQ) chargeQ = chargeT.map(() => 1);
  // edges: 0 right side (inner->outer), 1 outer, 2 left side (outer->inner), 3 inner
  const charges = [];
  for (let i = 0; i < chargeT.length; i++) {
    const t = chargeT[i];
    const qi = q * chargeQ[i];
    charges.push({ edge: 0, t, q: +qi }); // right side, inner->outer
    charges.push({ edge: 2, t: 1 - t, q: -qi }); // left side, outer->inner (mirror so radii match)
  }
  const spec = new MoleculeSpec({
    name: name ?? `wedge${nRing}`,
    verts,
    charges,
  });
  // distance from ring center to the wedge centroid, before recentering —
  // lets ringPose() place wedges into an exactly closed ring
  spec._ringCentroidRadius = polygonCentroid(verts)[1];
  spec._nRing = nRing;
  return spec;
}

// ---------------------------------------------------------------------------
// Regular-polygon monomers
//
// A regular n-gon with a + face and a − face behaves predictably. Mating two
// faces fixes the relative orientation of the partners: if the + is on edge 0
// and the − on edge k, every bond rotates the next molecule by the same angle
//
//     rot = pi - 2*pi*k/n
//
// so a closed ring of m molecules needs m*rot to be a whole number of turns:
//
//     m = 2n / (n - 2k)
//
// k = n/2 (opposite faces) gives rot = 0 — partners stay aligned and the
// chain runs straight forever instead of closing. When 2n/(n-2k) isn't an
// integer no ring closes and you get open, frustrated aggregates.
//
// This one rule covers the whole family: squares with adjacent charged faces
// make 2x2 pinwheels (n=4, k=1 -> m=4), hexagons make trimers (k=1 -> 3),
// 6-rings (k=2 -> 6) or fibres (k=3), triangles make 6-membered rosettes
// (n=3, k=1 -> 6), pentagons make 10-rings (k=2 -> 10).
// ---------------------------------------------------------------------------

// Edge length L of a regular n-gon with circumradius R, and the inverse —
// shapes are sized by edge length so every preset presents a similar-sized
// binding face, and one set of tuned charge parameters works across them.
export function circumradiusForEdge(n, edgeLength) {
  return edgeLength / (2 * Math.sin(Math.PI / n));
}

export function regularPolygon(n, radius, rotation = 0) {
  const verts = [];
  for (let i = 0; i < n; i++) {
    const a = rotation + (2 * Math.PI * i) / n;
    verts.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return verts;
}

// What does a facePair(n, k) monomer assemble into?
export function predictedAssembly(n, k) {
  if (k <= 0 || k >= n) return { kind: 'invalid', size: null };
  const kk = Math.min(k, n - k); // edge k and edge n-k are mirror images
  const denom = n - 2 * kk;
  if (denom === 0) return { kind: 'chain', size: Infinity };
  const m = (2 * n) / denom;
  if (!Number.isInteger(m)) return { kind: 'open', size: null };
  return { kind: 'ring', size: m };
}

// Golomb-ruler charge positions along a face: all pairwise spacings distinct,
// so a face that slides out of registration can align at most one charge pair
// (weak, breaks thermally) while a flush face aligns all of them. Same idea
// that made the wedge rings work.
const GOLOMB_T = [0.2, 0.45, 0.8];

// Polar face layout, for mixtures.
//
// A self-complementary monomer only ever mates its + face to a − face, so the
// two faces cannot be confused. Ionic species can: with every face the same
// sign, A's out-face is just as attracted to B's out-face as to B's in-face,
// and a reversed junction breaks ring closure. Measured with the tuned kernel,
// the symmetric-ish GOLOMB_T above makes a reversed bond 86% as strong as a
// correct one — hopeless discrimination.
//
// Clustering the charges toward one end gives the face a head and a tail, so
// it can only mate one way round. Same Golomb property (spacings 0.12/0.18/
// 0.30 all distinct, so a slid face still catches at most one pair), but a
// reversed bond now measures 11% of a correct one — weak enough to break in
// the selective temperature window while correct bonds hold.
export const POLAR_T = [0.08, 0.2, 0.38];
// The mirrored layout. A species using POLAR_T on both faces and one using
// POLAR_MIRROR_T on both faces bind only each other: measured with the tuned
// kernel, the wanted A-B interface is -53.9 while A-A is +9.8 (repulsive),
// B-B is -4.4 (8% of wanted), and a reversed junction is +53.9 — repelled
// outright, because same-role faces end up carrying the same sign.
export const POLAR_MIRROR_T = POLAR_T.map((t) => 1 - t);

// Charges on one pair of faces: +q on edge 0, −q on edge k.
// The − positions are mirrored (1 − t) because mating faces run in opposite
// directions, so this is what puts the charges on top of each other.
export function facePair({
  n = 6,
  k = 2,
  edgeLength = 5,
  q = 1,
  // Charge positions along the two faces. By default edge k mirrors edge 0
  // (t -> 1-t), which is what makes a monomer self-complementary: its own two
  // faces register against each other.
  //
  // Passing the SAME positions for both faces instead makes the monomer
  // unable to bind its own kind, because a face only registers against one
  // carrying the mirrored positions. Two species — one using P on both faces,
  // the other using 1-P — then bind only each other. That is how the mixed
  // presets get species specificity while keeping the +/- asymmetry below.
  chargeT = GOLOMB_T,
  chargeTk = null,
  // Sign on each face, as [edge 0, edge k]. Keep these opposite: it is what
  // gives a molecule a direction. A chain always runs out-face(+) to
  // in-face(-), so every molecule is traversed the same way round and its
  // turn always has the same sign.
  //
  // Making both faces one sign (an "ionic" monomer) also prevents self-
  // binding, but destroys that handedness: the molecule can then be entered
  // on either face, so its turn can go either way and chains zigzag with no
  // net curvature instead of curling into rings. Use matched positions for
  // specificity and keep the signs opposite.
  signs = [+1, -1],
  name = null,
  color = null,
} = {}) {
  const radius = circumradiusForEdge(n, edgeLength);
  const tk = chargeTk ?? chargeT.map((t) => 1 - t);
  const charges = [];
  chargeT.forEach((t, i) => {
    charges.push({ edge: 0, t, q: q * signs[0] });
    charges.push({ edge: k % n, t: tk[i], q: q * signs[1] });
  });
  const spec = new MoleculeSpec({
    name: name ?? `${n}gon-k${k}`,
    // point edge 0 outward along +x so the shapes read consistently on screen
    verts: regularPolygon(n, radius, -Math.PI / n),
    charges,
    color,
  });
  spec._n = n;
  spec._k = k;
  spec._signs = signs;
  // The turn this monomer contributes to a chain: the chain direction rotates
  // by pi minus the angle between its two charged faces. A ring closes when
  // the turns around it sum to a whole number of revolutions — the general
  // form of m = 2n/(n-2k), and what lets two different shapes be combined.
  spec._turn = Math.PI - (2 * Math.PI * (k % n)) / n;
  spec._predicted =
    signs[0] === signs[1]
      ? { kind: 'ionic', size: null } // binds only the opposite species
      : predictedAssembly(n, k);
  return spec;
}

// Total molecules in the smallest alternating A/B ring, or null if the turns
// never sum to a whole revolution.
export function predictedMixedRing(specA, specB, maxPairs = 60) {
  const turn = specA._turn + specB._turn;
  if (Math.abs(turn) < 1e-12) return { kind: 'chain', size: Infinity };
  for (let p = 1; p <= maxPairs; p++) {
    const turns = (p * turn) / (2 * Math.PI);
    if (Math.abs(turns - Math.round(turns)) < 1e-9 && Math.round(turns) >= 1) {
      return { kind: 'ring', size: 2 * p, pairs: p };
    }
  }
  return { kind: 'open', size: null };
}

// Charges on every face, so the monomer tiles instead of closing a ring.
// Opposite faces must carry opposite signs (edge i pairs with edge i + n/2 in
// an aligned tiling), so the first half of the edges get +q and the rest −q.
// Only defined for even n — odd polygons have no opposite-edge pairing.
export function tiler({
  n = 6,
  edgeLength = 5,
  q = 1,
  chargeT = GOLOMB_T,
  // null: opposite faces carry opposite signs, so the monomer tiles with
  // copies of itself. +1/−1: every face carries that sign, giving an ionic
  // tiler that can only tile against the opposite species — two of them
  // build a checkerboard lattice rather than a uniform sheet.
  uniformSign = null,
  name = null,
  color = null,
} = {}) {
  if (n % 2 !== 0) throw new Error(`tiler needs an even-sided polygon, got n=${n}`);
  const radius = circumradiusForEdge(n, edgeLength);
  const half = n / 2;
  const charges = [];
  for (let e = 0; e < half; e++) {
    for (const t of chargeT) {
      charges.push({ edge: e, t, q: q * (uniformSign ?? +1) });
      charges.push({ edge: e + half, t: 1 - t, q: q * (uniformSign ?? -1) });
    }
  }
  const spec = new MoleculeSpec({
    name: name ?? `${n}gon-sheet`,
    verts: regularPolygon(n, radius, -Math.PI / n),
    charges,
    color,
  });
  spec._n = n;
  spec._predicted = { kind: 'sheet', size: Infinity };
  return spec;
}

export function transformVerts(verts, pose) {
  const c = Math.cos(pose.angle);
  const s = Math.sin(pose.angle);
  return verts.map(([x, y]) => [pose.x + x * c - y * s, pose.y + x * s + y * c]);
}

// Given a molecule at `pose`, return the pose of the partner whose + face
// (edge 0) mates flush against this molecule's − face (edge k).
//
// Mating faces run in opposite directions, so the partner's vertex 0 lands on
// our vertex k+1 and its vertex 1 on our vertex k. Two point correspondences
// determine the rigid transform exactly — chaining this is a more honest test
// of the closure rule than assuming a ring radius, since it only asserts that
// bonds mate and then asks whether the chain happens to close.
export function mateNextPose(spec, pose, partner = spec) {
  const n = spec.verts.length;
  const k = spec._k % n;
  const world = transformVerts(spec.verts, pose);
  const t0 = world[(k + 1) % n]; // where the partner's vertex 0 must go
  const t1 = world[k]; //           where the partner's vertex 1 must go

  const [v0x, v0y] = partner.verts[0];
  const [v1x, v1y] = partner.verts[1];
  const angle =
    Math.atan2(t1[1] - t0[1], t1[0] - t0[0]) - Math.atan2(v1y - v0y, v1x - v0x);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: t0[0] - (v0x * c - v0y * s), y: t0[1] - (v0x * s + v0y * c), angle };
}

// Chain m bonded copies starting from the identity pose. `specs` may be a
// single spec or a repeating sequence, so an alternating A/B ring is just
// facePairChain([A, B], m).
export function facePairChain(specs, m) {
  const seq = Array.isArray(specs) ? specs : [specs];
  const poses = [{ x: 0, y: 0, angle: 0 }];
  for (let i = 1; i < m; i++) {
    const from = seq[(i - 1) % seq.length];
    const to = seq[i % seq.length];
    poses.push(mateNextPose(from, poses[i - 1], to));
  }
  return poses;
}

// The pose of wedge k in a closed ring centered at (cx, cy): used by tests
// and for seeding "perfect ring" sanity scenarios. Returns {x, y, angle}
// such that spec-local coordinates map into the ring.
export function ringPose(spec, nRing, k, cx = 0, cy = 0) {
  // wedge() built verts pointing along +y before recentering; the recentering
  // shifted them by the centroid. Reconstruct: ring-space pos of the local
  // origin is the centroid of the un-recentered wedge, which lies on +y axis.
  // Its distance from ring center is the centroid radius.
  const theta = (k * 2 * Math.PI) / nRing;
  // centroid radius: centroid of the recentered poly is origin, and the
  // original poly had centroid at (0, rC) => local->ring: rotate by -theta? Use +.
  const rC = spec._ringCentroidRadius;
  return {
    x: cx + rC * -Math.sin(theta),
    y: cy + rC * Math.cos(theta),
    angle: theta,
  };
}
