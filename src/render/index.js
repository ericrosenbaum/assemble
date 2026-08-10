// Picks a renderer. WebGL2 instanced draws are the fast path and what the app
// uses; the Canvas2D renderer stays the fallback, and is also what the headless
// capture harness uses deliberately — it draws the text HUD that the GIFs in
// this repo carry, and capture is bound by simulation time rather than drawing.

import { Renderer as Canvas2DRenderer } from './draw.js';
import { GLRenderer } from './gl.js';

export { Canvas2DRenderer, GLRenderer };

// A canvas hands out one context for its lifetime, so a scenario switch has to
// reuse the renderer it already built rather than construct a second one.
const CACHE = new WeakMap();

export function createRenderer(canvas, box, opts = {}) {
  const { prefer = 'gl', ...rest } = opts;
  const cached = CACHE.get(canvas);
  if (cached && cached.prefer === prefer) {
    cached.renderer.box = box;
    return cached.renderer;
  }
  if (prefer !== '2d') {
    try {
      const r = new GLRenderer(canvas, box, rest);
      CACHE.set(canvas, { prefer, renderer: r });
      return r;
    } catch (err) {
      // A canvas that has already handed out a 2d context cannot give a webgl2
      // one, and some environments have no WebGL2 at all — either way the
      // Canvas2D path is correct, just slower.
      console.warn('WebGL2 renderer unavailable, falling back to Canvas2D:', err.message);
    }
  }
  const r = new Canvas2DRenderer(canvas, box, rest);
  CACHE.set(canvas, { prefer, renderer: r });
  return r;
}
