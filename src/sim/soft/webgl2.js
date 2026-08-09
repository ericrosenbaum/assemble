// Soft-body engine, WebGL2 GPGPU backend.
//
// Same physics as cpu.js, but the per-particle force + integration runs in
// a fragment shader over RGBA32F textures (ping-pong FBOs, MRT for
// position+velocity). All-pairs WCA/Coulomb is a loop over a particle
// texture inside the shader — fine on a GPU even for thousands of
// particles. Positions are read back (readPixels) only when the renderer or
// analysis asks, once per displayed frame at most.
//
// This backend works everywhere WebGL2 + EXT_color_buffer_float is
// available (desktop browsers, iOS Safari, and headless Chromium with
// SwiftShader — which is how it's tested in CI).

import { SoftEngineCPU } from './cpu.js';

const VS = `#version 300 es
precision highp float;
const vec2 quad[6] = vec2[6](vec2(-1.,-1.), vec2(1.,-1.), vec2(-1.,1.), vec2(-1.,1.), vec2(1.,-1.), vec2(1.,1.));
void main() { gl_Position = vec4(quad[gl_VertexID], 0., 1.); }
`;

const FS = (maxN, texW) => `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D posTex;  // xy pos, z charge, w mol id
uniform sampler2D velTex;  // xy vel
uniform sampler2D topoA;   // prev, next, hub, isHub
uniform sampler2D topoB;   // restPrev, restNext, restHub, -
uniform sampler2D topoC;   // molStart, molPerim, -, -

uniform int uN;
uniform float dt, gamma, kickScale, kSpring, springDamp;
uniform float sigma, epsWCA, kCoulomb, lambda, softR, cutoff;
uniform vec2 halfBox;      // wall positions (half extents minus margin)
uniform float kWall;
uniform uint seed;

layout(location = 0) out vec4 outPos;
layout(location = 1) out vec4 outVel;

const int TEXW = ${texW};
ivec2 tc(int i) { return ivec2(i % TEXW, i / TEXW); }

// pcg hash -> uniform floats for Box-Muller gaussians
uint pcg(uint v) { v = v * 747796405u + 2891336453u; v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u; return (v >> 22u) ^ v; }
float rnd(uint x) { return float(pcg(x)) / 4294967296.0; }
vec2 gauss2(uint id) {
  float u1 = max(rnd(id * 2u + seed * 2654435769u), 1e-7);
  float u2 = rnd(id * 2u + 1u + seed * 2654435769u);
  float m = sqrt(-2.0 * log(u1));
  return vec2(m * cos(6.28318530718 * u2), m * sin(6.28318530718 * u2));
}

vec2 springForce(vec2 p, vec2 v, int j, float rest) {
  vec4 pj = texelFetch(posTex, tc(j), 0);
  vec4 vj = texelFetch(velTex, tc(j), 0);
  vec2 d = p - pj.xy;
  float len = max(length(d), 1e-9);
  vec2 dir = d / len;
  float rel = dot(v - vj.xy, dir);
  return (-kSpring * (len - rest) - springDamp * rel) * dir;
}

void main() {
  int i = int(gl_FragCoord.y) * TEXW + int(gl_FragCoord.x);
  vec4 pme = texelFetch(posTex, tc(i), 0);
  vec4 vme = texelFetch(velTex, tc(i), 0);
  if (i >= uN) { outPos = pme; outVel = vme; return; }
  vec2 p = pme.xy;
  vec2 v = vme.xy;
  float q = pme.z;
  float mol = pme.w;
  vec4 tA = texelFetch(topoA, tc(i), 0);
  vec4 tB = texelFetch(topoB, tc(i), 0);
  vec4 tC = texelFetch(topoC, tc(i), 0);

  vec2 F = vec2(0.);

  // springs
  if (tA.w < 0.5) {
    // perimeter particle: prev, next, hub
    F += springForce(p, v, int(tA.x), tB.x);
    F += springForce(p, v, int(tA.y), tB.y);
    F += springForce(p, v, int(tA.z), tB.z);
  } else {
    // hub: springs to every perimeter particle of this molecule
    int start = int(tC.x);
    int nPerim = int(tC.y);
    for (int k = 0; k < ${maxN}; k++) {
      if (k >= nPerim) break;
      int j = start + k;
      float rest = texelFetch(topoB, tc(j), 0).z;
      F += springForce(p, v, j, rest);
    }
  }

  // all-pairs: WCA between molecules + screened Coulomb between charges
  float rcWCA = sigma * 1.122462048309373;
  float rc2 = rcWCA * rcWCA;
  float cut2 = cutoff * cutoff;
  float s2 = sigma * sigma;
  for (int j = 0; j < ${maxN}; j++) {
    if (j >= uN) break;
    if (j == i) continue;
    vec4 pj = texelFetch(posTex, tc(j), 0);
    if (pj.w == mol) continue;
    vec2 d = p - pj.xy;
    float r2 = dot(d, d);
    float qq = q * pj.z;
    // opposite-charge sticky sites are exempt from contact repulsion
    if (r2 < rc2 && r2 > 0. && qq >= 0.) {
      float r2c = max(r2, 0.49 * s2);
      float inv2 = s2 / r2c;
      float inv6 = inv2 * inv2 * inv2;
      F += (24. * epsWCA * inv6 * (2. * inv6 - 1.) / r2c) * d;
    }
    // must match pairForce() exactly — softened distance in exp() too, so the
    // force vanishes at coincidence instead of flipping sign discontinuously
    if (qq != 0. && r2 < cut2) {
      float rs = sqrt(r2 + softR * softR);
      float dUdrs = (kCoulomb * qq * exp(-rs / lambda) / rs) * (-1. / lambda - 1. / rs);
      F += (-dUdrs / rs) * d;
    }
  }

  // walls
  if (p.x > halfBox.x) F.x -= kWall * (p.x - halfBox.x);
  else if (p.x < -halfBox.x) F.x -= kWall * (p.x + halfBox.x);
  if (p.y > halfBox.y) F.y -= kWall * (p.y - halfBox.y);
  else if (p.y < -halfBox.y) F.y -= kWall * (p.y + halfBox.y);

  // Langevin bath + integrate (semi-implicit Euler, matches cpu.js)
  vec2 a = F - gamma * v + kickScale * gauss2(uint(i));
  v += a * dt;
  float vm = length(v);
  if (vm > 80.) v *= 80. / vm;
  p += v * dt;

  outPos = vec4(p, q, mol);
  outVel = vec4(v, 0., 0.);
}
`;

export class SoftEngineWebGL2 extends SoftEngineCPU {
  constructor(opts) {
    super(opts);
    this.backendName = 'soft/webgl2';
    this._gpuStepsPending = 0;
    this._dirty = false;
    this._initGL();
    this.ready = Promise.resolve(this);
  }

  _initGL() {
    const n = this.L.n;
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(4, 4) : document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false });
    if (!gl) throw new Error('webgl2 unavailable');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
    this.gl = gl;

    const texW = 256;
    const texH = Math.max(1, Math.ceil(n / texW));
    this.texW = texW;
    this.texH = texH;
    const cap = texW * texH;

    // pack state + topology
    const pos = new Float32Array(cap * 4);
    const vel = new Float32Array(cap * 4);
    const a = new Float32Array(cap * 4);
    const b = new Float32Array(cap * 4);
    const c = new Float32Array(cap * 4);
    const { L } = this;
    // rebuild per-particle topology from the spring list
    const prev = new Int32Array(n).fill(-1);
    const next = new Int32Array(n).fill(-1);
    const hubOf = new Int32Array(n).fill(-1);
    const restPrev = new Float32Array(n);
    const restNext = new Float32Array(n);
    const restHub = new Float32Array(n);
    const isHub = new Uint8Array(n);
    for (let mi = 0; mi < this.instances.length; mi++) {
      const start = L.molStart[mi];
      const nPer = L.molPerim[mi];
      const hub = start + L.molCount[mi] - 1;
      isHub[hub] = 1;
      for (let k = 0; k < nPer; k++) {
        const i = start + k;
        prev[i] = start + ((k + nPer - 1) % nPer);
        next[i] = start + ((k + 1) % nPer);
        hubOf[i] = hub;
      }
    }
    for (let s = 0; s < L.sa.length; s++) {
      const i = L.sa[s];
      const j = L.sb[s];
      if (isHub[j]) restHub[i] = L.sl[s];
      else if (next[i] === j) restNext[i] = L.sl[s];
      else if (prev[i] === j) restPrev[i] = L.sl[s];
      // symmetric entries
      if (isHub[i]) restHub[j] = L.sl[s];
      else if (next[j] === i) restNext[j] = L.sl[s];
      else if (prev[j] === i) restPrev[j] = L.sl[s];
    }
    for (let i = 0; i < n; i++) {
      pos[i * 4] = L.x[i];
      pos[i * 4 + 1] = L.y[i];
      pos[i * 4 + 2] = L.q[i];
      pos[i * 4 + 3] = L.mol[i];
      vel[i * 4] = L.vx[i];
      vel[i * 4 + 1] = L.vy[i];
      a[i * 4] = prev[i];
      a[i * 4 + 1] = next[i];
      a[i * 4 + 2] = hubOf[i];
      a[i * 4 + 3] = isHub[i];
      b[i * 4] = restPrev[i];
      b[i * 4 + 1] = restNext[i];
      b[i * 4 + 2] = restHub[i];
      c[i * 4] = L.molStart[L.mol[i]];
      c[i * 4 + 1] = L.molPerim[L.mol[i]];
    }

    const mkTex = (data) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, texW, texH, 0, gl.RGBA, gl.FLOAT, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.tex = {
      pos: [mkTex(pos), mkTex(pos)],
      vel: [mkTex(vel), mkTex(vel)],
      topoA: mkTex(a),
      topoB: mkTex(b),
      topoC: mkTex(c),
    };
    this.cur = 0;

    this.fbo = [gl.createFramebuffer(), gl.createFramebuffer()];
    for (let i = 0; i < 2; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex.pos[i], 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.tex.vel[i], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error('float FBO incomplete');
    }

    // compile
    const maxN = Math.max(n, 1);
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        throw new Error('shader: ' + gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS(maxN, texW)));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('link: ' + gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.uni = {};
    for (const name of [
      'posTex', 'velTex', 'topoA', 'topoB', 'topoC', 'uN', 'dt', 'gamma', 'kickScale',
      'kSpring', 'springDamp', 'sigma', 'epsWCA', 'kCoulomb', 'lambda', 'softR',
      'cutoff', 'halfBox', 'kWall', 'seed',
    ])
      this.uni[name] = gl.getUniformLocation(prog, name);

    this._readBuf = new Float32Array(cap * 4);
    this.packBuf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.packBuf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, this._readBuf.byteLength, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this._fence = null;
    this._gpuSeed = (this.seed * 2654435761) >>> 0;
  }

  step() {
    this.applySchedule();
    const { gl, params, L } = this;
    const nSub = params.substeps;
    const dt = params.dt / nSub;
    const kick = Math.sqrt((2 * params.gamma * params.kT) / dt);

    gl.useProgram(this.prog);
    gl.viewport(0, 0, this.texW, this.texH);
    gl.uniform1i(this.uni.posTex, 0);
    gl.uniform1i(this.uni.velTex, 1);
    gl.uniform1i(this.uni.topoA, 2);
    gl.uniform1i(this.uni.topoB, 3);
    gl.uniform1i(this.uni.topoC, 4);
    gl.uniform1i(this.uni.uN, L.n);
    gl.uniform1f(this.uni.dt, dt);
    gl.uniform1f(this.uni.gamma, params.gamma);
    gl.uniform1f(this.uni.kickScale, kick);
    gl.uniform1f(this.uni.kSpring, params.kSpring);
    gl.uniform1f(this.uni.springDamp, params.springDamp);
    gl.uniform1f(this.uni.sigma, params.sigma);
    gl.uniform1f(this.uni.epsWCA, params.epsWCA);
    gl.uniform1f(this.uni.kCoulomb, params.k);
    gl.uniform1f(this.uni.lambda, params.lambda);
    gl.uniform1f(this.uni.softR, params.soft);
    gl.uniform1f(this.uni.cutoff, params.cutoff);
    gl.uniform2f(this.uni.halfBox, this.box.w / 2 - 1, this.box.h / 2 - 1);
    gl.uniform1f(this.uni.kWall, 200);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.topoA);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.topoB);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.topoC);

    for (let s = 0; s < nSub; s++) {
      const src = this.cur;
      const dst = 1 - this.cur;
      this._gpuSeed = (this._gpuSeed + 0x9e3779b9) >>> 0;
      gl.uniform1ui(this.uni.seed, this._gpuSeed);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex.pos[src]);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.tex.vel[src]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.cur = dst;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._dirty = true;
    this.stepCount++;
    this.time += params.dt;
  }

  // Positions are pulled back through a pixel-pack buffer guarded by a fence,
  // so the CPU never blocks waiting for the GPU. A plain readPixels into a
  // typed array stalls the pipeline until every queued substep has finished,
  // which on real hardware costs far more than the physics itself.
  //
  // The trade-off is that rendering can lag the simulation by a frame. That is
  // invisible at interactive rates and irrelevant to correctness, since the
  // authoritative state lives in the GPU textures either way.
  _startReadback() {
    const { gl } = this;
    if (this._fence || !this._dirty) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.packBuf);
    gl.readPixels(0, 0, this.texW, this.texH, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this._fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this._dirty = false;
    gl.flush();
  }

  // Consume a completed readback if one is ready. `block` forces a wait, which
  // the parity test needs to compare an exact step count against the CPU.
  _pollReadback(block = false) {
    const { gl, L } = this;
    if (!this._fence) return false;
    const status = gl.clientWaitSync(this._fence, 0, block ? 1e8 : 0);
    if (status === gl.TIMEOUT_EXPIRED) return false;
    gl.deleteSync(this._fence);
    this._fence = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.packBuf);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this._readBuf);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    for (let i = 0; i < L.n; i++) {
      L.x[i] = this._readBuf[i * 4];
      L.y[i] = this._readBuf[i * 4 + 1];
    }
    return true;
  }

  _sync(block = true) {
    this._startReadback();
    this._pollReadback(block);
  }

  // Called once per rendered frame by the worker loop; kicks off the next
  // readback and picks up the previous one without ever blocking.
  async flush() {
    this._pollReadback(false);
    this._startReadback();
  }

  // Read accessors take the freshest completed readback rather than stalling
  // for the in-flight one — a frame of lag beats a pipeline bubble.
  poses() {
    this._sync(false);
    return super.poses();
  }

  outlines() {
    this._sync(false);
    return super.outlines();
  }

  chargeWorld() {
    this._sync(false);
    return super.chargeWorld();
  }

  free() {
    const gl = this.gl;
    if (gl && this._fence) {
      gl.deleteSync(this._fence);
      this._fence = null;
    }
    gl?.deleteBuffer(this.packBuf);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
