// Soft-body engine, WebGPU compute backend (experimental).
//
// Same physics as cpu.js/webgl2.js, as a WGSL compute kernel over storage
// buffers with ping-pong. WebGPU readback is asynchronous, so positions
// used for rendering/analysis lag the simulation by up to one displayed
// frame (flush() awaits a full sync). Feature-detected at runtime; the
// engine picker falls back to WebGL2/CPU when unavailable.
//
// NOTE: this backend cannot run in the headless-Chromium test container
// (no WebGPU adapter there) — it is exercised on real hardware instead.
// The physics kernel is a line-for-line port of the tested WebGL2 shader.

import { SoftEngineCPU } from './cpu.js';

const WGSL = (maxPerim) => /* wgsl */ `
struct Params {
  n: u32,
  seed: u32,
  dt: f32,
  gamma: f32,
  kick: f32,
  kSpring: f32,
  springDamp: f32,
  sigma: f32,
  epsWCA: f32,
  kCoulomb: f32,
  lambda: f32,
  softR: f32,
  cutoff: f32,
  kWall: f32,
  halfBoxX: f32,
  halfBoxY: f32,
};

@group(0) @binding(0) var<storage, read> posIn: array<vec4f>;   // xy pos, z q, w mol
@group(0) @binding(1) var<storage, read> velIn: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> posOut: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> velOut: array<vec4f>;
@group(0) @binding(4) var<storage, read> topoA: array<vec4f>;   // prev,next,hub,isHub
@group(0) @binding(5) var<storage, read> topoB: array<vec4f>;   // rests
@group(0) @binding(6) var<storage, read> topoC: array<vec4f>;   // molStart, molPerim
@group(0) @binding(7) var<uniform> P: Params;

fn pcg(v0: u32) -> u32 {
  var v = v0 * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}
fn rnd(x: u32) -> f32 { return f32(pcg(x)) / 4294967296.0; }
fn gauss2(id: u32) -> vec2f {
  let u1 = max(rnd(id * 2u + P.seed * 2654435769u), 1e-7);
  let u2 = rnd(id * 2u + 1u + P.seed * 2654435769u);
  let m = sqrt(-2.0 * log(u1));
  return vec2f(m * cos(6.28318530718 * u2), m * sin(6.28318530718 * u2));
}

fn springForce(p: vec2f, v: vec2f, j: u32, rest: f32) -> vec2f {
  let pj = posIn[j];
  let vj = velIn[j];
  let d = p - pj.xy;
  let len = max(length(d), 1e-9);
  let dir = d / len;
  let rel = dot(v - vj.xy, dir);
  return (-P.kSpring * (len - rest) - P.springDamp * rel) * dir;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let pme = posIn[i];
  var p = pme.xy;
  var v = velIn[i].xy;
  let q = pme.z;
  let mol = pme.w;
  let tA = topoA[i];
  let tB = topoB[i];
  let tC = topoC[i];

  var F = vec2f(0.0);

  if (tA.w < 0.5) {
    F += springForce(p, v, u32(tA.x), tB.x);
    F += springForce(p, v, u32(tA.y), tB.y);
    F += springForce(p, v, u32(tA.z), tB.z);
  } else {
    let start = u32(tC.x);
    let nPerim = u32(tC.y);
    for (var k = 0u; k < ${maxPerim}u; k++) {
      if (k >= nPerim) { break; }
      let j = start + k;
      F += springForce(p, v, j, topoB[j].z);
    }
  }

  let rcWCA = P.sigma * 1.122462048309373;
  let rc2 = rcWCA * rcWCA;
  let cut2 = P.cutoff * P.cutoff;
  let s2 = P.sigma * P.sigma;
  for (var j = 0u; j < P.n; j++) {
    if (j == i) { continue; }
    let pj = posIn[j];
    if (pj.w == mol) { continue; }
    let d = p - pj.xy;
    let r2 = dot(d, d);
    let qq = q * pj.z;
    if (r2 < rc2 && r2 > 0.0 && qq >= 0.0) {
      let r2c = max(r2, 0.49 * s2);
      let inv2 = s2 / r2c;
      let inv6 = inv2 * inv2 * inv2;
      F += (24.0 * P.epsWCA * inv6 * (2.0 * inv6 - 1.0) / r2c) * d;
    }
    // must match pairForce() exactly — softened distance in exp() too, so the
    // force vanishes at coincidence instead of flipping sign discontinuously
    if (qq != 0.0 && r2 < cut2) {
      let rs = sqrt(r2 + P.softR * P.softR);
      let dUdrs = (P.kCoulomb * qq * exp(-rs / P.lambda) / rs) * (-1.0 / P.lambda - 1.0 / rs);
      F += (-dUdrs / rs) * d;
    }
  }

  if (p.x > P.halfBoxX) { F.x -= P.kWall * (p.x - P.halfBoxX); }
  else if (p.x < -P.halfBoxX) { F.x -= P.kWall * (p.x + P.halfBoxX); }
  if (p.y > P.halfBoxY) { F.y -= P.kWall * (p.y - P.halfBoxY); }
  else if (p.y < -P.halfBoxY) { F.y -= P.kWall * (p.y + P.halfBoxY); }

  let a = F - P.gamma * v + P.kick * gauss2(i);
  v += a * P.dt;
  let vm = length(v);
  if (vm > 80.0) { v *= 80.0 / vm; }
  p += v * P.dt;

  posOut[i] = vec4f(p, q, mol);
  velOut[i] = vec4f(v, 0.0, 0.0);
}
`;

export class SoftEngineWebGPU extends SoftEngineCPU {
  constructor(opts) {
    super(opts);
    this.backendName = 'soft/webgpu';
    this._dirty = false;
    this._mapPending = false;
    this.ready = this._initGPU();
  }

  async _initGPU() {
    if (!navigator.gpu) throw new Error('WebGPU unavailable');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const device = await adapter.requestDevice();
    this.device = device;
    const { L } = this;
    const n = L.n;
    const bytes = n * 16;

    const pos = new Float32Array(n * 4);
    const vel = new Float32Array(n * 4);
    const a = new Float32Array(n * 4);
    const b = new Float32Array(n * 4);
    const c = new Float32Array(n * 4);
    // same topology packing as the WebGL2 backend
    const prev = new Int32Array(n).fill(-1);
    const next = new Int32Array(n).fill(-1);
    const isHub = new Uint8Array(n);
    const restPrev = new Float32Array(n);
    const restNext = new Float32Array(n);
    const restHub = new Float32Array(n);
    let maxPerim = 1;
    for (let mi = 0; mi < this.instances.length; mi++) {
      const start = L.molStart[mi];
      const nPer = L.molPerim[mi];
      maxPerim = Math.max(maxPerim, nPer);
      const hub = start + L.molCount[mi] - 1;
      isHub[hub] = 1;
      for (let k = 0; k < nPer; k++) {
        const i = start + k;
        prev[i] = start + ((k + nPer - 1) % nPer);
        next[i] = start + ((k + 1) % nPer);
      }
    }
    for (let s = 0; s < L.sa.length; s++) {
      const i = L.sa[s];
      const j = L.sb[s];
      if (isHub[j]) restHub[i] = L.sl[s];
      else if (next[i] === j) restNext[i] = L.sl[s];
      else if (prev[i] === j) restPrev[i] = L.sl[s];
      if (isHub[i]) restHub[j] = L.sl[s];
      else if (next[j] === i) restNext[j] = L.sl[s];
      else if (prev[j] === i) restPrev[j] = L.sl[s];
    }
    for (let i = 0; i < n; i++) {
      pos.set([L.x[i], L.y[i], L.q[i], L.mol[i]], i * 4);
      vel.set([L.vx[i], L.vy[i], 0, 0], i * 4);
      const hub = L.molStart[L.mol[i]] + L.molCount[L.mol[i]] - 1;
      a.set([prev[i], next[i], hub, isHub[i]], i * 4);
      b.set([restPrev[i], restNext[i], restHub[i], 0], i * 4);
      c.set([L.molStart[L.mol[i]], L.molPerim[L.mol[i]], 0, 0], i * 4);
    }

    const mkBuf = (data, usage) => {
      const buf = device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, data);
      return buf;
    };
    const S = GPUBufferUsage.STORAGE;
    this.buf = {
      pos: [mkBuf(pos, S | GPUBufferUsage.COPY_SRC), mkBuf(pos, S | GPUBufferUsage.COPY_SRC)],
      vel: [mkBuf(vel, S), mkBuf(vel, S)],
      topoA: mkBuf(a, S),
      topoB: mkBuf(b, S),
      topoC: mkBuf(c, S),
      params: device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      staging: device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    };

    const module = device.createShaderModule({ code: WGSL(maxPerim) });
    this.pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    const layout = this.pipeline.getBindGroupLayout(0);
    const mkGroup = (src) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: this.buf.pos[src] } },
          { binding: 1, resource: { buffer: this.buf.vel[src] } },
          { binding: 2, resource: { buffer: this.buf.pos[1 - src] } },
          { binding: 3, resource: { buffer: this.buf.vel[1 - src] } },
          { binding: 4, resource: { buffer: this.buf.topoA } },
          { binding: 5, resource: { buffer: this.buf.topoB } },
          { binding: 6, resource: { buffer: this.buf.topoC } },
          { binding: 7, resource: { buffer: this.buf.params } },
        ],
      });
    this.groups = [mkGroup(0), mkGroup(1)];
    this.cur = 0;
    this._gpuSeed = (this.seed * 2654435761) >>> 0;
    this._paramF32 = new Float32Array(16);
    this._paramU32 = new Uint32Array(this._paramF32.buffer);
    return this;
  }

  _writeParams(dt) {
    const p = this.params;
    const f = this._paramF32;
    const u = this._paramU32;
    u[0] = this.L.n;
    u[1] = this._gpuSeed;
    f[2] = dt;
    f[3] = p.gamma;
    f[4] = Math.sqrt((2 * p.gamma * p.kT) / dt);
    f[5] = p.kSpring;
    f[6] = p.springDamp;
    f[7] = p.sigma;
    f[8] = p.epsWCA;
    f[9] = p.k;
    f[10] = p.lambda;
    f[11] = p.soft;
    f[12] = p.cutoff;
    f[13] = 200; // kWall
    f[14] = this.box.w / 2 - 1;
    f[15] = this.box.h / 2 - 1;
    this.device.queue.writeBuffer(this.buf.params, 0, this._paramF32);
  }

  step() {
    this.applySchedule();
    const nSub = this.params.substeps;
    const dt = this.params.dt / nSub;
    const wg = Math.ceil(this.L.n / 64);
    for (let s = 0; s < nSub; s++) {
      this._gpuSeed = (this._gpuSeed + 0x9e3779b9) >>> 0;
      this._writeParams(dt);
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.groups[this.cur]);
      pass.dispatchWorkgroups(wg);
      pass.end();
      this.device.queue.submit([enc.finish()]);
      this.cur = 1 - this.cur;
    }
    this._dirty = true;
    this.stepCount++;
    this.time += this.params.dt;
    // opportunistic async readback so render data stays fresh
    if (!this._mapPending) this.flush();
  }

  async flush() {
    if (!this._dirty || this._mapPending) return;
    this._mapPending = true;
    this._dirty = false;
    const { device, L } = this;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(this.buf.pos[this.cur], 0, this.buf.staging, 0, L.n * 16);
    device.queue.submit([enc.finish()]);
    try {
      await this.buf.staging.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(this.buf.staging.getMappedRange());
      for (let i = 0; i < L.n; i++) {
        L.x[i] = data[i * 4];
        L.y[i] = data[i * 4 + 1];
      }
      this.buf.staging.unmap();
    } finally {
      this._mapPending = false;
    }
  }

  free() {
    this.device?.destroy();
  }
}
