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
