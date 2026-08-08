// Canvas2D renderer: world-space molecules onto a canvas, with charge dots
// and a small HUD. Works identically on-screen and in headless capture.

const PALETTE = [
  '#e8b04b', // amber
  '#7fb069', // green
  '#6c91bf', // steel blue
  '#c76f8a', // rose
  '#8a7fb0', // violet
  '#5fb0a5', // teal
];

export class Renderer {
  constructor(canvas, box, { background = '#141a20' } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.box = box;
    this.background = background;
  }

  // world (y up, origin center) -> screen
  _tx() {
    const { width, height } = this.canvas;
    const sx = width / this.box.w;
    const sy = height / this.box.h;
    const s = Math.min(sx, sy);
    return { s, ox: width / 2, oy: height / 2 };
  }

  draw(engine, { hud = true } = {}) {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    const { s, ox, oy } = this._tx();
    ctx.fillStyle = this.background;
    ctx.fillRect(0, 0, width, height);

    // box border
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox - (this.box.w / 2) * s, oy - (this.box.h / 2) * s, this.box.w * s, this.box.h * s);

    // Molecules, grouped by spec so each colour costs one fill and one stroke
    // rather than a pair per molecule.
    const outlines = engine.outlines();
    const bySpec = new Map();
    for (let i = 0; i < outlines.length; i++) {
      const specIdx = engine.instances[i].spec;
      let path = bySpec.get(specIdx);
      if (!path) bySpec.set(specIdx, (path = new Path2D()));
      const poly = outlines[i];
      for (let j = 0; j < poly.length; j++) {
        const X = ox + poly[j][0] * s;
        const Y = oy - poly[j][1] * s;
        if (j === 0) path.moveTo(X, Y);
        else path.lineTo(X, Y);
      }
      path.closePath();
    }
    ctx.lineWidth = Math.max(1, 0.18 * s);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    for (const [specIdx, path] of bySpec) {
      const color = engine.specs[specIdx].color || PALETTE[specIdx % PALETTE.length];
      ctx.fillStyle = color + 'cc';
      ctx.fill(path);
      ctx.stroke(path);
    }

    // Charge sites, batched: one path per sign instead of a fill+stroke pair
    // per site (which was 12 canvas calls per molecule).
    const sites = engine.chargeWorld();
    const r = Math.max(1.5, 0.42 * s);
    const pos = new Path2D();
    const neg = new Path2D();
    const glyphs = new Path2D();
    // Below a few pixels the +/- glyph is indistinguishable, so skip it and
    // let the dot colour carry the sign.
    const drawGlyphs = r >= 3;
    const g = r * 0.5;
    for (let i = 0; i < sites.count; i++) {
      const X = ox + sites.x[i] * s;
      const Y = oy - sites.y[i] * s;
      const positive = sites.q[i] > 0;
      const p = positive ? pos : neg;
      p.moveTo(X + r, Y);
      p.arc(X, Y, r, 0, Math.PI * 2);
      if (drawGlyphs) {
        glyphs.moveTo(X - g, Y);
        glyphs.lineTo(X + g, Y);
        if (positive) {
          glyphs.moveTo(X, Y - g);
          glyphs.lineTo(X, Y + g);
        }
      }
    }
    ctx.fillStyle = '#ff5c5c';
    ctx.fill(pos);
    ctx.fillStyle = '#5ca8ff';
    ctx.fill(neg);
    if (drawGlyphs) {
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = Math.max(1, r * 0.28);
      ctx.stroke(glyphs);
    }

    if (hud) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `${Math.round(height * 0.032)}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      const kT = engine.params.kT;
      ctx.fillText(`T = ${kT.toFixed(2)}   step ${engine.stepCount}`, 10, 8);
      // temperature bar
      const bw = width * 0.22;
      const frac = Math.min(1, kT / 4);
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(10, height * 0.032 + 16, bw, 6);
      const hue = 220 - 220 * frac; // blue (cold) -> red (hot)
      ctx.fillStyle = `hsl(${hue}, 80%, 55%)`;
      ctx.fillRect(10, height * 0.032 + 16, bw * frac, 6);
    }
  }
}
