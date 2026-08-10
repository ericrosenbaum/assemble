// Screened-Coulomb (Yukawa) interaction between charge sites.
//
//   rs   = sqrt(r^2 + soft^2)          softened distance
//   U    = k q1 q2 exp(-rs/lambda) / rs
//   F    = -dU/dr = -(dU/drs) * (r/rs)
//
// The screening length lambda keeps binding short-ranged and specific —
// that's what makes assembled structures stable instead of one big clump.
//
// `soft` must appear in the exponential too, not just the denominator. An
// earlier version softened only the magnitude and left the raw r in exp(),
// which leaves dU/dr non-zero at r = 0: the force was -8.6 approaching
// coincidence and flipped to +8.6 on the other side, a jump of 17 across an
// infinitesimal distance. Flush mating deliberately parks opposite charges on
// top of each other, so every bonded pair sat exactly on that cusp and any
// jiggle through r = 0 delivered an impulsive kick. Docked chains — six such
// pairs per joint at the strongest interface in the app — burst apart.
//
// Written this way dU/dr carries a factor r/rs and vanishes linearly at
// contact, so the force is spring-like there: bounded stiffness, which is what
// an explicit integrator needs. See test/stability.test.mjs.
export function pairForce(dx, dy, q1q2, { k, lambda, soft }) {
  const rs = Math.sqrt(dx * dx + dy * dy + soft * soft);
  const dUdrs = ((k * q1q2 * Math.exp(-rs / lambda)) / rs) * (-1 / lambda - 1 / rs);
  // f = -(dU/drs)(drs/dr)/r = -(dU/drs)/rs, since drs/dr = r/rs
  const f = -dUdrs / rs;
  return [f * dx, f * dy];
}

export function pairEnergy(dx, dy, q1q2, { k, lambda, soft }) {
  const rs = Math.sqrt(dx * dx + dy * dy + soft * soft);
  return (k * q1q2 * Math.exp(-rs / lambda)) / rs;
}

// Reference all-pairs accumulator: every inter-molecular charge-site pair.
// sites: {x, y, q, mol} flat typed arrays; out fx/fy same length.
// O(M^2) with cutoff. Kept as the correctness reference that
// accumulateChargeForcesCulled is tested against — prefer the culled version
// in engines.
export function accumulateChargeForces(sites, params, outFx, outFy) {
  const { x, y, q, mol, count } = sites;
  const cutoff = params.cutoff;
  const c2 = cutoff * cutoff;
  outFx.fill(0, 0, count);
  outFy.fill(0, 0, count);
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (mol[i] === mol[j]) continue;
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];
      if (dx * dx + dy * dy > c2) continue;
      const [fx, fy] = pairForce(dx, dy, q[i] * q[j], params);
      outFx[i] += fx;
      outFy[i] += fy;
      outFx[j] -= fx;
      outFy[j] -= fy;
    }
  }
}

// Largest distance from a spec's charge-site centroid to any of its sites.
// This is a rigid-body invariant (both the sites and their centroid rotate
// together), which is what makes the culling bound below exact.
export function siteSpread(spec) {
  const sites = spec.chargeSites();
  if (sites.length === 0) return 0;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of sites) {
    cx += x;
    cy += y;
  }
  cx /= sites.length;
  cy /= sites.length;
  let max = 0;
  for (const [x, y] of sites) max = Math.max(max, Math.hypot(x - cx, y - cy));
  return max;
}

// Build the per-molecule site index the culled accumulator needs. Charge
// sites are laid out contiguously per molecule by the engines, so a molecule
// is just a (start, len) span. Call once at engine construction.
// `spread` must be the max siteSpread() over every spec in play.
export function buildMoleculeIndex(sites, nMol, spread) {
  const start = new Int32Array(nMol);
  const len = new Int32Array(nMol);
  for (let i = 0; i < sites.count; i++) len[sites.mol[i]]++;
  for (let m = 1; m < nMol; m++) start[m] = start[m - 1] + len[m - 1];
  return {
    nMol,
    start,
    len,
    cx: new Float64Array(nMol),
    cy: new Float64Array(nMol),
    spread,
    grid: new MoleculeGrid(nMol),
  };
}

// Uniform bucketing of molecule centroids, so the force accumulator can visit
// only nearby molecule pairs instead of all of them.
//
// This is deliberately not `CellGrid` from cellgrid.js: that one is sized from
// a fixed box at construction, and molecule centroids need bounds that follow
// the actual occupied extent (the accumulator has no box, and its callers
// include tests that scatter poses freely). Everything else — counting sort
// into preallocated typed arrays, rebuilt in place with no allocation — is the
// same idea.
class MoleculeGrid {
  constructor(capacity) {
    this.items = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
    this.counts = new Int32Array(0);
    this.cellStart = new Int32Array(0);
    this.nx = 0;
    this.ny = 0;
    this.cell = 1;
    this.minX = 0;
    this.minY = 0;
  }

  // `minCell` must be >= the interaction reach, so any interacting pair lands
  // in the same or an adjacent cell. Cells are only ever grown beyond it (to
  // bound memory if one molecule strays far), which adds candidates but can
  // never drop a pair — the accumulator still distance-checks every candidate.
  build(cx, cy, n, minCell) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let m = 0; m < n; m++) {
      if (cx[m] < minX) minX = cx[m];
      if (cx[m] > maxX) maxX = cx[m];
      if (cy[m] < minY) minY = cy[m];
      if (cy[m] > maxY) maxY = cy[m];
    }
    if (!Number.isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = 0;
      maxY = 0;
    }

    // Keep the cell count proportional to the molecule count: a grid much
    // finer than the occupancy costs more to clear than it saves.
    const maxCells = 4 * n + 64;
    let cell = minCell;
    const w = maxX - minX;
    const h = maxY - minY;
    for (;;) {
      const nx = Math.max(1, Math.floor(w / cell) + 1);
      const ny = Math.max(1, Math.floor(h / cell) + 1);
      if (nx * ny <= maxCells) {
        this.nx = nx;
        this.ny = ny;
        break;
      }
      cell *= 2;
    }
    this.cell = cell;
    this.minX = minX;
    this.minY = minY;

    const nc = this.nx * this.ny;
    if (this.counts.length < nc) {
      this.counts = new Int32Array(nc);
      this.cellStart = new Int32Array(nc + 1);
    }
    const { counts, cellStart, cellOf, items, nx } = this;
    counts.fill(0, 0, nc);

    for (let m = 0; m < n; m++) {
      const gx = ((cx[m] - minX) / cell) | 0;
      const gy = ((cy[m] - minY) / cell) | 0;
      const c = (gy >= this.ny ? this.ny - 1 : gy) * nx + (gx >= nx ? nx - 1 : gx);
      cellOf[m] = c;
      counts[c]++;
    }
    let acc = 0;
    for (let c = 0; c < nc; c++) {
      cellStart[c] = acc;
      acc += counts[c];
    }
    cellStart[nc] = acc;
    counts.fill(0, 0, nc);
    for (let m = 0; m < n; m++) {
      const c = cellOf[m];
      items[cellStart[c] + counts[c]++] = m;
    }
  }
}

// Same physics as accumulateChargeForces, but rejects whole molecule pairs on
// centre distance before touching individual sites, and inlines the force
// kernel so there is no per-pair array allocation in the inner loop.
//
// The culling is exact. Every site of a molecule lies within `spread` of that
// molecule's site-centroid, so for sites i in A and j in B the triangle
// inequality gives |i - j| <= |cA - cB| + 2*spread. If |cA - cB| exceeds
// cutoff + 2*spread then every pair is beyond the cutoff and the whole
// molecule pair can be skipped without dropping an interaction. Results match
// the reference to float rounding (measured max |df| ~1.8e-15, from summation
// reassociation only).
export function accumulateChargeForcesCulled(sites, params, outFx, outFy, molIndex) {
  const { x, y, q, mol, count } = sites;
  const { k, lambda, soft, cutoff } = params;
  const c2 = cutoff * cutoff;
  const soft2 = soft * soft;
  const invLambda = 1 / lambda;
  outFx.fill(0, 0, count);
  outFy.fill(0, 0, count);

  const { nMol, start, len, cx, cy, spread, grid } = molIndex;
  for (let m = 0; m < nMol; m++) {
    cx[m] = 0;
    cy[m] = 0;
  }
  for (let i = 0; i < count; i++) {
    const m = mol[i];
    cx[m] += x[i];
    cy[m] += y[i];
  }
  for (let m = 0; m < nMol; m++) {
    cx[m] /= len[m];
    cy[m] /= len[m];
  }

  const reach = cutoff + 2 * spread;
  const reach2 = reach * reach;

  // Visiting every molecule pair to reject most of them is O(M^2) even when the
  // rejection is cheap, which is what capped the engine at a few thousand
  // molecules. Bucketing centroids at the reach makes the visit count
  // proportional to the number of genuinely nearby pairs instead.
  grid.build(cx, cy, nMol, reach);
  const { items, cellStart, nx, ny } = grid;

  // Each unordered pair must be visited exactly once, so a cell pairs with
  // itself (upper triangle only) plus four of its eight neighbours; the other
  // four see this cell as their forward neighbour.
  const FWD = [
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  const pair = (a, b) => {
    const ddx = cx[a] - cx[b];
    const ddy = cy[a] - cy[b];
    if (ddx * ddx + ddy * ddy > reach2) return;
    const ia0 = start[a];
    const ia1 = ia0 + len[a];
    const ib0 = start[b];
    const ib1 = ib0 + len[b];
    for (let i = ia0; i < ia1; i++) {
      const xi = x[i];
      const yi = y[i];
      const qi = q[i];
      let fxi = 0;
      let fyi = 0;
      for (let j = ib0; j < ib1; j++) {
        const dx = xi - x[j];
        const dy = yi - y[j];
        const r2 = dx * dx + dy * dy;
        if (r2 > c2) continue;
        // must match pairForce() exactly — softened distance in exp() too
        const rs = Math.sqrt(r2 + soft2);
        const dUdrs = ((k * qi * q[j] * Math.exp(-rs * invLambda)) / rs) * (-invLambda - 1 / rs);
        const f = -dUdrs / rs;
        const fx = f * dx;
        const fy = f * dy;
        fxi += fx;
        fyi += fy;
        outFx[j] -= fx;
        outFy[j] -= fy;
      }
      outFx[i] += fxi;
      outFy[i] += fyi;
    }
  };

  for (let gy = 0; gy < ny; gy++) {
    for (let gx = 0; gx < nx; gx++) {
      const c = gy * nx + gx;
      const s0 = cellStart[c];
      const s1 = cellStart[c + 1];
      if (s0 === s1) continue;
      for (let u = s0; u < s1; u++) {
        for (let v = u + 1; v < s1; v++) pair(items[u], items[v]);
      }
      for (let d = 0; d < 4; d++) {
        const hx = gx + FWD[d][0];
        const hy = gy + FWD[d][1];
        if (hx < 0 || hx >= nx || hy >= ny) continue;
        const n2 = hy * nx + hx;
        const t0 = cellStart[n2];
        const t1 = cellStart[n2 + 1];
        for (let u = s0; u < s1; u++) {
          for (let v = t0; v < t1; v++) pair(items[u], items[v]);
        }
      }
    }
  }
}
