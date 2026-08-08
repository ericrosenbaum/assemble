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

// Accumulate forces between all inter-molecular charge-site pairs.
// sites: {x, y, q, mol} flat typed arrays; out fx/fy same length.
// O(M^2) with cutoff — M is a few hundred at most for the rigid engine.
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
