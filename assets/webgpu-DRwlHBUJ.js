import{SoftEngineCPU as e}from"./cpu-D_6V2ywX.js";var t=e=>`
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
    for (var k = 0u; k < ${e}u; k++) {
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
`,n=class extends e{constructor(e){super(e),this.backendName=`soft/webgpu`,this._dirty=!1,this._mapPending=!1,this.ready=this._initGPU()}async _initGPU(){if(!navigator.gpu)throw Error(`WebGPU unavailable`);let e=await navigator.gpu.requestAdapter();if(!e)throw Error(`no WebGPU adapter`);let n=await e.requestDevice();this.device=n;let{L:r}=this,i=r.n,a=i*16,o=new Float32Array(i*4),s=new Float32Array(i*4),c=new Float32Array(i*4),l=new Float32Array(i*4),u=new Float32Array(i*4),d=new Int32Array(i).fill(-1),f=new Int32Array(i).fill(-1),p=new Uint8Array(i),m=new Float32Array(i),h=new Float32Array(i),g=new Float32Array(i),_=1;for(let e=0;e<this.instances.length;e++){let t=r.molStart[e],n=r.molPerim[e];_=Math.max(_,n);let i=t+r.molCount[e]-1;p[i]=1;for(let e=0;e<n;e++){let r=t+e;d[r]=t+(e+n-1)%n,f[r]=t+(e+1)%n}}for(let e=0;e<r.sa.length;e++){let t=r.sa[e],n=r.sb[e];p[n]?g[t]=r.sl[e]:f[t]===n?h[t]=r.sl[e]:d[t]===n&&(m[t]=r.sl[e]),p[t]?g[n]=r.sl[e]:f[n]===t?h[n]=r.sl[e]:d[n]===t&&(m[n]=r.sl[e])}for(let e=0;e<i;e++){o.set([r.x[e],r.y[e],r.q[e],r.mol[e]],e*4),s.set([r.vx[e],r.vy[e],0,0],e*4);let t=r.molStart[r.mol[e]]+r.molCount[r.mol[e]]-1;c.set([d[e],f[e],t,p[e]],e*4),l.set([m[e],h[e],g[e],0],e*4),u.set([r.molStart[r.mol[e]],r.molPerim[r.mol[e]],0,0],e*4)}let v=(e,t)=>{let r=n.createBuffer({size:e.byteLength,usage:t|GPUBufferUsage.COPY_DST});return n.queue.writeBuffer(r,0,e),r},y=GPUBufferUsage.STORAGE;this.buf={pos:[v(o,y|GPUBufferUsage.COPY_SRC),v(o,y|GPUBufferUsage.COPY_SRC)],vel:[v(s,y),v(s,y)],topoA:v(c,y),topoB:v(l,y),topoC:v(u,y),params:n.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),staging:n.createBuffer({size:a,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ})};let b=n.createShaderModule({code:t(_)});this.pipeline=n.createComputePipeline({layout:`auto`,compute:{module:b,entryPoint:`main`}});let x=this.pipeline.getBindGroupLayout(0),S=e=>n.createBindGroup({layout:x,entries:[{binding:0,resource:{buffer:this.buf.pos[e]}},{binding:1,resource:{buffer:this.buf.vel[e]}},{binding:2,resource:{buffer:this.buf.pos[1-e]}},{binding:3,resource:{buffer:this.buf.vel[1-e]}},{binding:4,resource:{buffer:this.buf.topoA}},{binding:5,resource:{buffer:this.buf.topoB}},{binding:6,resource:{buffer:this.buf.topoC}},{binding:7,resource:{buffer:this.buf.params}}]});return this.groups=[S(0),S(1)],this.cur=0,this._gpuSeed=this.seed*2654435761>>>0,this._paramF32=new Float32Array(16),this._paramU32=new Uint32Array(this._paramF32.buffer),this}_writeParams(e){let t=this.params,n=this._paramF32,r=this._paramU32;r[0]=this.L.n,r[1]=this._gpuSeed,n[2]=e,n[3]=t.gamma,n[4]=Math.sqrt(2*t.gamma*t.kT/e),n[5]=t.kSpring,n[6]=t.springDamp,n[7]=t.sigma,n[8]=t.epsWCA,n[9]=t.k,n[10]=t.lambda,n[11]=t.soft,n[12]=t.cutoff,n[13]=200,n[14]=this.box.w/2-1,n[15]=this.box.h/2-1,this.device.queue.writeBuffer(this.buf.params,0,this._paramF32)}step(){this.applySchedule();let e=this.params.substeps,t=this.params.dt/e,n=Math.ceil(this.L.n/64);for(let r=0;r<e;r++){this._gpuSeed=this._gpuSeed+2654435769>>>0,this._writeParams(t);let e=this.device.createCommandEncoder(),r=e.beginComputePass();r.setPipeline(this.pipeline),r.setBindGroup(0,this.groups[this.cur]),r.dispatchWorkgroups(n),r.end(),this.device.queue.submit([e.finish()]),this.cur=1-this.cur}this._dirty=!0,this.stepCount++,this.time+=this.params.dt,this._mapPending||this.flush()}async flush(){if(!this._dirty||this._mapPending)return;this._mapPending=!0,this._dirty=!1;let{device:e,L:t}=this,n=e.createCommandEncoder();n.copyBufferToBuffer(this.buf.pos[this.cur],0,this.buf.staging,0,t.n*16),e.queue.submit([n.finish()]);try{await this.buf.staging.mapAsync(GPUMapMode.READ);let e=new Float32Array(this.buf.staging.getMappedRange());for(let n=0;n<t.n;n++)t.x[n]=e[n*4],t.y[n]=e[n*4+1];this.buf.staging.unmap()}finally{this._mapPending=!1}}free(){this.device?.destroy()}};export{n as SoftEngineWebGPU};