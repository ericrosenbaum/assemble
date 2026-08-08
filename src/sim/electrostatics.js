// Screened-Coulomb (Yukawa) interaction between charge sites.
//
// U(r) = k q1 q2 exp(-r/lambda) / sqrt(r^2 + soft^2)
// F(r) = -dU/dr, pointing along the pair separation.
//
// The screening length lambda keeps binding short-ranged and specific —
// that's what makes assembled structures stable instead of one big clump.
// `soft` regularizes the singularity when mating sites coincide.

export function pairForce(dx, dy, q1q2, { k, lambda, soft }) {
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);
  const rs = Math.sqrt(r2 + soft * soft);
  const e = Math.exp(-r / lambda);
  // U = k q1q2 e / rs ; dU/dr = k q1q2 e (-1/(lambda rs) - r/rs^3)
  const dUdr = k * q1q2 * e * (-1 / (lambda * rs) - r / (rs * rs * rs));
  // force on site 1 = -dU/dr * rhat
  const f = -dUdr / (r + 1e-12);
  return [f * dx, f * dy];
}

export function pairEnergy(dx, dy, q1q2, { k, lambda, soft }) {
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);
  return (k * q1q2 * Math.exp(-r / lambda)) / Math.sqrt(r2 + soft * soft);
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
  };
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

  const { nMol, start, len, cx, cy, spread } = molIndex;
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
  for (let a = 0; a < nMol; a++) {
    const ia0 = start[a];
    const ia1 = ia0 + len[a];
    for (let b = a + 1; b < nMol; b++) {
      const ddx = cx[a] - cx[b];
      const ddy = cy[a] - cy[b];
      if (ddx * ddx + ddy * ddy > reach2) continue;
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
          const r = Math.sqrt(r2);
          const rs = Math.sqrt(r2 + soft2);
          const kq = k * qi * q[j] * Math.exp(-r * invLambda);
          const dUdr = kq * (-invLambda / rs - r / (rs * rs * rs));
          const f = -dUdr / (r + 1e-12);
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
    }
  }
}
