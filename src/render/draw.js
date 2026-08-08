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

    const outlines = engine.outlines();
    for (let i = 0; i < outlines.length; i++) {
      const poly = outlines[i];
      const specIdx = engine.instances[i].spec;
      const color = engine.specs[specIdx].color || PALETTE[specIdx % PALETTE.length];
      ctx.beginPath();
      for (let j = 0; j < poly.length; j++) {
        const X = ox + poly[j][0] * s;
        const Y = oy - poly[j][1] * s;
        if (j === 0) ctx.moveTo(X, Y);
        else ctx.lineTo(X, Y);
      }
      ctx.closePath();
      ctx.fillStyle = color + 'cc';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = Math.max(1, 0.18 * s);
      ctx.stroke();
    }

    // charge sites
    const sites = engine.chargeWorld();
    const r = Math.max(1.5, 0.42 * s);
    for (let i = 0; i < sites.count; i++) {
      const X = ox + sites.x[i] * s;
      const Y = oy - sites.y[i] * s;
      ctx.beginPath();
      ctx.arc(X, Y, r, 0, Math.PI * 2);
      ctx.fillStyle = sites.q[i] > 0 ? '#ff5c5c' : '#5ca8ff';
      ctx.fill();
      // +/- glyph
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = Math.max(1, r * 0.28);
      ctx.beginPath();
      ctx.moveTo(X - r * 0.5, Y);
      ctx.lineTo(X + r * 0.5, Y);
      if (sites.q[i] > 0) {
        ctx.moveTo(X, Y - r * 0.5);
        ctx.lineTo(X, Y + r * 0.5);
      }
      ctx.stroke();
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
