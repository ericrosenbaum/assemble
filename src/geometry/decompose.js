// Convex decomposition of a simple polygon.
//
// Rapier's 2D colliders are convex, so a molecule with a pocket has to be
// given to the physics engine as several convex pieces attached to the same
// rigid body. Without this a concave outline collides as its convex hull —
// the pocket silently fills in and nothing can dock into it.
//
// Ear clipping produces triangles; a greedy merge pass then joins neighbours
// whose union is still convex. Merging matters for more than collider count:
// every internal edge between pieces is a seam a sliding ligand can catch on,
// and a notched block goes from ~6 triangles to ~3 pieces.

const EPS = 1e-9;

export function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

// True when every turn goes the same way (allowing collinear vertices).
export function isConvex(poly) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const c = cross(poly[i], poly[(i + 1) % poly.length], poly[(i + 2) % poly.length]);
    if (Math.abs(c) < EPS) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function pointInTriangle(p, a, b, c) {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const neg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const pos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(neg && pos);
}

// Ear clipping. Input must be a simple (non-self-intersecting) polygon;
// winding is normalised to CCW first so the ear test has a fixed sense.
export function triangulate(poly) {
  const pts = signedArea(poly) < 0 ? [...poly].reverse() : [...poly];
  const idx = pts.map((_, i) => i);
  const out = [];
  let guard = 0;

  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = pts[idx[(i + idx.length - 1) % idx.length]];
      const b = pts[idx[i]];
      const c = pts[idx[(i + 1) % idx.length]];
      if (cross(a, b, c) <= EPS) continue; // reflex or degenerate: not an ear

      let contains = false;
      for (let j = 0; j < idx.length; j++) {
        if (j === i || j === (i + idx.length - 1) % idx.length || j === (i + 1) % idx.length) continue;
        if (pointInTriangle(pts[idx[j]], a, b, c)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      out.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    // Degenerate input (collinear runs, duplicate points): stop rather than spin.
    if (!clipped) break;
  }
  if (idx.length === 3) out.push(idx.map((i) => pts[i]));
  return out;
}

// Shared edge between two polygons, as index pairs, or null.
function sharedEdge(A, B) {
  for (let i = 0; i < A.length; i++) {
    const a1 = A[i];
    const a2 = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      const b1 = B[j];
      const b2 = B[(j + 1) % B.length];
      // neighbours traverse the shared edge in opposite directions
      if (
        Math.abs(a1[0] - b2[0]) < EPS &&
        Math.abs(a1[1] - b2[1]) < EPS &&
        Math.abs(a2[0] - b1[0]) < EPS &&
        Math.abs(a2[1] - b1[1]) < EPS
      ) {
        return { i, j };
      }
    }
  }
  return null;
}

// Join two polygons across their shared edge, dropping that edge.
//
// A's shared edge is (A[i], A[i+1]) and B's is (B[j], B[j+1]), traversed in
// opposite directions, so A[i] == B[j+1] and A[i+1] == B[j]. Walking all of A
// from i+1 already emits both shared vertices (first and last), so B must be
// walked from j+2 — starting at j+1 would repeat A's last vertex and produce a
// degenerate polygon.
function mergeAcross(A, B, e) {
  const out = [];
  for (let k = 1; k <= A.length; k++) out.push(A[(e.i + k) % A.length]);
  for (let k = 2; k < B.length; k++) out.push(B[(e.j + k) % B.length]);
  // drop vertices that became collinear once the seam went away
  return out.filter((p, k) => {
    const prev = out[(k + out.length - 1) % out.length];
    const next = out[(k + 1) % out.length];
    return Math.abs(cross(prev, p, next)) > 1e-7;
  });
}

// Triangulate, then greedily merge neighbours while the union stays convex.
export function decomposeConvex(poly) {
  if (isConvex(poly)) return [signedArea(poly) < 0 ? [...poly].reverse() : [...poly]];

  let pieces = triangulate(poly);
  let merged = true;
  let guard = 0;
  while (merged && guard++ < 1000) {
    merged = false;
    outer: for (let a = 0; a < pieces.length; a++) {
      for (let b = a + 1; b < pieces.length; b++) {
        const e = sharedEdge(pieces[a], pieces[b]);
        if (!e) continue;
        const candidate = mergeAcross(pieces[a], pieces[b], e);
        if (candidate.length < 3 || !isConvex(candidate)) continue;
        pieces = pieces.filter((_, k) => k !== a && k !== b);
        pieces.push(candidate);
        merged = true;
        break outer;
      }
    }
  }
  return pieces;
}
