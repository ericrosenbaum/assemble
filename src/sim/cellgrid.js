// Uniform-grid neighbour finder built with a counting sort into preallocated
// typed arrays. Rebuilt in place every force evaluation with zero allocation —
// the previous implementation allocated a Map plus one array per occupied cell
// on every evaluation, which (at 6 substeps per step) dominated the soft
// engine's runtime.
//
// Usage:
//   grid.build(x, y, count)                  // all particles
//   grid.build(x, y, count, subsetIndices)   // a subset (e.g. charged only)
// then walk the 3x3 neighbourhood via cellStart/items.

export class CellGrid {
  // `cell` should be the interaction cutoff: any pair within the cutoff is
  // then guaranteed to fall in the same or an adjacent cell.
  constructor({ box, cell, capacity, margin = null }) {
    this.cell = cell;
    // Particles are kept in the box by wall forces but can overshoot slightly,
    // so pad generously and clamp; anything beyond the pad is far outside the
    // interaction range of anything inside it.
    const pad = margin ?? Math.max(4 * cell, 8);
    this.minX = -box.w / 2 - pad;
    this.minY = -box.h / 2 - pad;
    this.nx = Math.max(1, Math.ceil((box.w + 2 * pad) / cell));
    this.ny = Math.max(1, Math.ceil((box.h + 2 * pad) / cell));
    const nc = this.nx * this.ny;
    this.cellStart = new Int32Array(nc + 1);
    this.counts = new Int32Array(nc);
    this.items = new Int32Array(capacity);
    this.cellOf = new Int32Array(capacity);
    this.count = 0;
  }

  cellX(x) {
    const cx = ((x - this.minX) / this.cell) | 0;
    return cx < 0 ? 0 : cx >= this.nx ? this.nx - 1 : cx;
  }

  cellY(y) {
    const cy = ((y - this.minY) / this.cell) | 0;
    return cy < 0 ? 0 : cy >= this.ny ? this.ny - 1 : cy;
  }

  // subset: optional Int32Array/Array of indices into x/y to include; when
  // given, `items` holds those original indices.
  build(x, y, count, subset = null) {
    const n = subset ? subset.length : count;
    this.count = n;
    const { counts, cellStart, cellOf, items, nx } = this;
    counts.fill(0);

    for (let k = 0; k < n; k++) {
      const i = subset ? subset[k] : k;
      const c = this.cellY(y[i]) * nx + this.cellX(x[i]);
      cellOf[k] = c;
      counts[c]++;
    }

    let acc = 0;
    for (let c = 0; c < counts.length; c++) {
      cellStart[c] = acc;
      acc += counts[c];
    }
    cellStart[counts.length] = acc;

    // reuse counts as the per-cell write cursor
    counts.fill(0);
    for (let k = 0; k < n; k++) {
      const c = cellOf[k];
      items[cellStart[c] + counts[c]++] = subset ? subset[k] : k;
    }
  }
}
