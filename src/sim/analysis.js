// Assembly analysis: build a bond graph from opposite-sign charge pairs in
// contact, then report cluster sizes and closed rings.

export function bondGraph(sites, { rBond = 1.6 } = {}) {
  const { x, y, q, mol, count } = sites;
  const r2 = rBond * rBond;
  const nMol = sites.nMol ?? Math.max(...mol) + 1;
  const adj = new Map(); // molA -> Set(molB)
  const addEdge = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (mol[i] === mol[j]) continue;
      if (q[i] * q[j] >= 0) continue;
      const dx = x[i] - x[j];
      const dy = y[i] - y[j];
      if (dx * dx + dy * dy < r2) addEdge(mol[i], mol[j]);
    }
  }
  return { adj, nMol };
}

export function clusters({ adj, nMol }) {
  const seen = new Set();
  const comps = [];
  for (let m = 0; m < nMol; m++) {
    if (seen.has(m)) continue;
    if (!adj.has(m)) {
      seen.add(m);
      comps.push([m]);
      continue;
    }
    const comp = [];
    const stack = [m];
    seen.add(m);
    while (stack.length) {
      const v = stack.pop();
      comp.push(v);
      for (const w of adj.get(v) ?? []) {
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

// A closed ring is a connected component where every member has exactly
// two bonded neighbors (a single cycle).
export function countRings(graph) {
  const comps = clusters(graph);
  const rings = [];
  for (const comp of comps) {
    if (comp.length < 3) continue;
    if (comp.every((m) => (graph.adj.get(m)?.size ?? 0) === 2)) rings.push(comp.length);
  }
  return rings;
}

export function stats(sites, opts = {}) {
  const graph = bondGraph(sites, opts);
  const comps = clusters(graph);
  const sizes = comps.map((c) => c.length).sort((a, b) => b - a);
  const rings = countRings(graph);
  return {
    clusters: comps.length,
    largest: sizes[0] ?? 0,
    sizes: sizes.slice(0, 8),
    rings,
    bonded: sizes.filter((s) => s > 1).reduce((a, b) => a + b, 0),
  };
}
