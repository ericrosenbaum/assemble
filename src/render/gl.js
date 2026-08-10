// Instanced WebGL2 renderer.
//
// Canvas2D rebuilds a path from every vertex of every molecule on every frame,
// which measured 2–4 ms at 300–460 molecules but 69 ms at 3,000 — the renderer,
// not the simulation, was what capped the interactive molecule count.
//
// A rigid molecule's geometry never changes in its own frame, so the polygon
// belongs on the GPU once and only the pose needs to travel per frame. Each
// species becomes one instanced draw call: a static triangulated fill plus a
// static outline loop, with a per-instance [x, y, cos, sin]. Charge sites are a
// single instanced quad pass that shades a disc in the fragment shader.
//
// Draw calls per frame go from "a path op per vertex" to two per species plus
// one, independent of how many molecules there are.

import { triangulate } from '../geometry/decompose.js';

const PALETTE = ['#e8b04b', '#7fb069', '#6c91bf', '#c76f8a', '#8a7fb0', '#5fb0a5'];

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h,
    16,
  );
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const MOL_VS = `#version 300 es
in vec2 aPos;          // vertex in molecule-local space
in vec4 aInst;         // x, y, cos, sin
uniform vec2 uScale;   // world -> clip
void main() {
  vec2 world = aInst.xy + vec2(
    aPos.x * aInst.z - aPos.y * aInst.w,
    aPos.x * aInst.w + aPos.y * aInst.z
  );
  gl_Position = vec4(world * uScale, 0.0, 1.0);
}`;

const MOL_FS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 frag;
void main() { frag = uColor; }`;

// Charge discs: one instanced unit quad, shaped and antialiased in the shader.
const SITE_VS = `#version 300 es
in vec2 aCorner;       // unit quad, -1..1
in vec3 aSite;         // x, y, q
uniform vec2 uScale;
uniform float uRadius; // world units
out vec2 vLocal;
out float vQ;
void main() {
  vLocal = aCorner;
  vQ = aSite.z;
  gl_Position = vec4((aSite.xy + aCorner * uRadius) * uScale, 0.0, 1.0);
}`;

const SITE_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
in float vQ;
uniform float uEdge;   // antialias width in quad units
out vec4 frag;
void main() {
  float d = length(vLocal);
  float a = 1.0 - smoothstep(1.0 - uEdge, 1.0, d);
  if (a <= 0.0) discard;
  vec3 c = vQ > 0.0 ? vec3(1.0, 0.36, 0.36) : vec3(0.36, 0.66, 1.0);
  frag = vec4(c, a);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(`shader: ${gl.getShaderInfoLog(sh)}`);
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

export function webgl2Available(canvas) {
  try {
    return !!canvas.getContext('webgl2');
  } catch {
    return false;
  }
}

export class GLRenderer {
  constructor(canvas, box, { background = '#141a20' } = {}) {
    this.canvas = canvas;
    this.box = box;
    this.bg = hexToRgb(background);
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      // headless capture reads the canvas back with toDataURL
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('webgl2 unavailable');
    this.gl = gl;
    this.molProg = program(gl, MOL_VS, MOL_FS);
    this.siteProg = program(gl, SITE_VS, SITE_FS);
    this.species = null;
    this._siteCap = 0;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // unit quad shared by every charge site
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.siteBuf = gl.createBuffer();

    // The box outline is one static line loop drawn as a single un-instanced
    // molecule at the identity pose.
    this.borderGeom = gl.createBuffer();
    this.borderInst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.borderInst);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0]), gl.STATIC_DRAW);
  }

  // Build one static geometry set per species, plus an instance buffer sized
  // to how many molecules of that species exist. Called once per scenario.
  _build(engine) {
    const gl = this.gl;
    // Scenario switches rebuild geometry; drop the previous set rather than
    // orphaning it on the GPU.
    for (const sp of this.species ?? []) {
      gl.deleteBuffer(sp.fill);
      gl.deleteBuffer(sp.loop);
      gl.deleteBuffer(sp.inst);
    }
    const specs = engine.specs;
    const members = specs.map(() => []);
    for (let i = 0; i < engine.instances.length; i++) members[engine.instances[i].spec].push(i);

    this.species = specs.map((spec, si) => {
      const tris = triangulate(spec.verts).flat(2);
      const fill = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, fill);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tris), gl.STATIC_DRAW);

      const loop = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, loop);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(spec.verts.flat()), gl.STATIC_DRAW);

      return {
        members: members[si],
        fill,
        fillCount: tris.length / 2,
        loop,
        loopCount: spec.verts.length,
        inst: gl.createBuffer(),
        instData: new Float32Array(members[si].length * 4),
        color: hexToRgb(spec.color || PALETTE[si % PALETTE.length]),
      };
    });
    this._builtFor = engine;
  }

  _bindInstanced(prog, geomBuf, geomAttr, instBuf, instAttr, instSize) {
    const gl = this.gl;
    const a0 = gl.getAttribLocation(prog, geomAttr);
    gl.bindBuffer(gl.ARRAY_BUFFER, geomBuf);
    gl.enableVertexAttribArray(a0);
    gl.vertexAttribPointer(a0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(a0, 0);

    const a1 = gl.getAttribLocation(prog, instAttr);
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.enableVertexAttribArray(a1);
    gl.vertexAttribPointer(a1, instSize, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(a1, 1);
  }

  draw(engine) {
    const gl = this.gl;
    if (this._builtFor !== engine) this._build(engine);
    const { width, height } = this.canvas;
    gl.viewport(0, 0, width, height);
    gl.clearColor(this.bg[0], this.bg[1], this.bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // world (y up, origin centre) -> clip, preserving aspect
    const s = Math.min(width / this.box.w, height / this.box.h);
    const uScale = [(2 * s) / width, (2 * s) / height];

    // Poses come straight from the worker when available; the in-thread engine
    // fills the same layout on demand.
    let poses = engine.poseArray?.();
    if (!poses) {
      this._poseScratch ??= new Float32Array(engine.instances.length * 3);
      engine.fillPoses(this._poseScratch);
      poses = this._poseScratch;
    }

    gl.useProgram(this.molProg);
    gl.uniform2f(gl.getUniformLocation(this.molProg, 'uScale'), uScale[0], uScale[1]);
    const colorLoc = gl.getUniformLocation(this.molProg, 'uColor');

    const hw = this.box.w / 2;
    const hh = this.box.h / 2;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.borderGeom);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-hw, -hh, hw, -hh, hw, hh, -hw, hh]),
      gl.DYNAMIC_DRAW,
    );
    this._bindInstanced(this.molProg, this.borderGeom, 'aPos', this.borderInst, 'aInst', 4);
    gl.uniform4f(colorLoc, 1, 1, 1, 0.25);
    gl.drawArraysInstanced(gl.LINE_LOOP, 0, 4, 1);

    for (const sp of this.species) {
      const d = sp.instData;
      for (let k = 0; k < sp.members.length; k++) {
        const m = sp.members[k];
        const a = poses[m * 3 + 2];
        d[k * 4] = poses[m * 3];
        d[k * 4 + 1] = poses[m * 3 + 1];
        d[k * 4 + 2] = Math.cos(a);
        d[k * 4 + 3] = Math.sin(a);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, sp.inst);
      gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);

      this._bindInstanced(this.molProg, sp.fill, 'aPos', sp.inst, 'aInst', 4);
      gl.uniform4f(colorLoc, sp.color[0], sp.color[1], sp.color[2], 0.8);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, sp.fillCount, sp.members.length);

      this._bindInstanced(this.molProg, sp.loop, 'aPos', sp.inst, 'aInst', 4);
      gl.uniform4f(colorLoc, 0, 0, 0, 0.45);
      gl.drawArraysInstanced(gl.LINE_LOOP, 0, sp.loopCount, sp.members.length);
    }

    // charge sites
    const sites = engine.chargeWorld();
    const n = sites.count;
    if (this._siteCap < n) {
      this._siteData = new Float32Array(n * 3);
      this._siteCap = n;
    }
    const sd = this._siteData;
    for (let i = 0; i < n; i++) {
      sd[i * 3] = sites.x[i];
      sd[i * 3 + 1] = sites.y[i];
      sd[i * 3 + 2] = sites.q[i];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.siteBuf);
    gl.bufferData(gl.ARRAY_BUFFER, sd, gl.DYNAMIC_DRAW);

    gl.useProgram(this.siteProg);
    gl.uniform2f(gl.getUniformLocation(this.siteProg, 'uScale'), uScale[0], uScale[1]);
    // Keep the dot a fixed size on screen, as the Canvas2D renderer does, so
    // charges stay visible when the box is large.
    gl.uniform1f(gl.getUniformLocation(this.siteProg, 'uRadius'), Math.max(1.5 / s, 0.42));
    gl.uniform1f(gl.getUniformLocation(this.siteProg, 'uEdge'), 0.35);
    this._bindInstanced(this.siteProg, this.quad, 'aCorner', this.siteBuf, 'aSite', 3);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
  }
}
