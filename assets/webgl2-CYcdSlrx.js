import{SoftEngineCPU as e}from"./cpu-D_6V2ywX.js";var t=`#version 300 es
precision highp float;
const vec2 quad[6] = vec2[6](vec2(-1.,-1.), vec2(1.,-1.), vec2(-1.,1.), vec2(-1.,1.), vec2(1.,-1.), vec2(1.,1.));
void main() { gl_Position = vec4(quad[gl_VertexID], 0., 1.); }
`,n=(e,t)=>`#version 300 es
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

const int TEXW = ${t};
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
    for (int k = 0; k < ${e}; k++) {
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
  for (int j = 0; j < ${e}; j++) {
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
`,r=class extends e{constructor(e){super(e),this.backendName=`soft/webgl2`,this._gpuStepsPending=0,this._dirty=!1,this._initGL(),this.ready=Promise.resolve(this)}_initGL(){let e=this.L.n,r=(typeof OffscreenCanvas<`u`?new OffscreenCanvas(4,4):document.createElement(`canvas`)).getContext(`webgl2`,{antialias:!1,depth:!1});if(!r)throw Error(`webgl2 unavailable`);if(!r.getExtension(`EXT_color_buffer_float`))throw Error(`EXT_color_buffer_float unavailable`);this.gl=r;let i=Math.max(1,Math.ceil(e/256));this.texW=256,this.texH=i;let a=256*i,o=new Float32Array(a*4),s=new Float32Array(a*4),c=new Float32Array(a*4),l=new Float32Array(a*4),u=new Float32Array(a*4),{L:d}=this,f=new Int32Array(e).fill(-1),p=new Int32Array(e).fill(-1),m=new Int32Array(e).fill(-1),h=new Float32Array(e),g=new Float32Array(e),_=new Float32Array(e),v=new Uint8Array(e);for(let e=0;e<this.instances.length;e++){let t=d.molStart[e],n=d.molPerim[e],r=t+d.molCount[e]-1;v[r]=1;for(let e=0;e<n;e++){let i=t+e;f[i]=t+(e+n-1)%n,p[i]=t+(e+1)%n,m[i]=r}}for(let e=0;e<d.sa.length;e++){let t=d.sa[e],n=d.sb[e];v[n]?_[t]=d.sl[e]:p[t]===n?g[t]=d.sl[e]:f[t]===n&&(h[t]=d.sl[e]),v[t]?_[n]=d.sl[e]:p[n]===t?g[n]=d.sl[e]:f[n]===t&&(h[n]=d.sl[e])}for(let t=0;t<e;t++)o[t*4]=d.x[t],o[t*4+1]=d.y[t],o[t*4+2]=d.q[t],o[t*4+3]=d.mol[t],s[t*4]=d.vx[t],s[t*4+1]=d.vy[t],c[t*4]=f[t],c[t*4+1]=p[t],c[t*4+2]=m[t],c[t*4+3]=v[t],l[t*4]=h[t],l[t*4+1]=g[t],l[t*4+2]=_[t],u[t*4]=d.molStart[d.mol[t]],u[t*4+1]=d.molPerim[d.mol[t]];let y=e=>{let t=r.createTexture();return r.bindTexture(r.TEXTURE_2D,t),r.texImage2D(r.TEXTURE_2D,0,r.RGBA32F,256,i,0,r.RGBA,r.FLOAT,e),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MIN_FILTER,r.NEAREST),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MAG_FILTER,r.NEAREST),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_WRAP_S,r.CLAMP_TO_EDGE),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_WRAP_T,r.CLAMP_TO_EDGE),t};this.tex={pos:[y(o),y(o)],vel:[y(s),y(s)],topoA:y(c),topoB:y(l),topoC:y(u)},this.cur=0,this.fbo=[r.createFramebuffer(),r.createFramebuffer()];for(let e=0;e<2;e++)if(r.bindFramebuffer(r.FRAMEBUFFER,this.fbo[e]),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_2D,this.tex.pos[e],0),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT1,r.TEXTURE_2D,this.tex.vel[e],0),r.drawBuffers([r.COLOR_ATTACHMENT0,r.COLOR_ATTACHMENT1]),r.checkFramebufferStatus(r.FRAMEBUFFER)!==r.FRAMEBUFFER_COMPLETE)throw Error(`float FBO incomplete`);let b=Math.max(e,1),x=(e,t)=>{let n=r.createShader(e);if(r.shaderSource(n,t),r.compileShader(n),!r.getShaderParameter(n,r.COMPILE_STATUS))throw Error(`shader: `+r.getShaderInfoLog(n));return n},S=r.createProgram();if(r.attachShader(S,x(r.VERTEX_SHADER,t)),r.attachShader(S,x(r.FRAGMENT_SHADER,n(b,256))),r.linkProgram(S),!r.getProgramParameter(S,r.LINK_STATUS))throw Error(`link: `+r.getProgramInfoLog(S));this.prog=S,this.uni={};for(let e of[`posTex`,`velTex`,`topoA`,`topoB`,`topoC`,`uN`,`dt`,`gamma`,`kickScale`,`kSpring`,`springDamp`,`sigma`,`epsWCA`,`kCoulomb`,`lambda`,`softR`,`cutoff`,`halfBox`,`kWall`,`seed`])this.uni[e]=r.getUniformLocation(S,e);this._readBuf=new Float32Array(a*4),this.packBuf=r.createBuffer(),r.bindBuffer(r.PIXEL_PACK_BUFFER,this.packBuf),r.bufferData(r.PIXEL_PACK_BUFFER,this._readBuf.byteLength,r.STREAM_READ),r.bindBuffer(r.PIXEL_PACK_BUFFER,null),this._fence=null,this._gpuSeed=this.seed*2654435761>>>0}step(){this.applySchedule();let{gl:e,params:t,L:n}=this,r=t.substeps,i=t.dt/r,a=Math.sqrt(2*t.gamma*t.kT/i);e.useProgram(this.prog),e.viewport(0,0,this.texW,this.texH),e.uniform1i(this.uni.posTex,0),e.uniform1i(this.uni.velTex,1),e.uniform1i(this.uni.topoA,2),e.uniform1i(this.uni.topoB,3),e.uniform1i(this.uni.topoC,4),e.uniform1i(this.uni.uN,n.n),e.uniform1f(this.uni.dt,i),e.uniform1f(this.uni.gamma,t.gamma),e.uniform1f(this.uni.kickScale,a),e.uniform1f(this.uni.kSpring,t.kSpring),e.uniform1f(this.uni.springDamp,t.springDamp),e.uniform1f(this.uni.sigma,t.sigma),e.uniform1f(this.uni.epsWCA,t.epsWCA),e.uniform1f(this.uni.kCoulomb,t.k),e.uniform1f(this.uni.lambda,t.lambda),e.uniform1f(this.uni.softR,t.soft),e.uniform1f(this.uni.cutoff,t.cutoff),e.uniform2f(this.uni.halfBox,this.box.w/2-1,this.box.h/2-1),e.uniform1f(this.uni.kWall,200),e.activeTexture(e.TEXTURE2),e.bindTexture(e.TEXTURE_2D,this.tex.topoA),e.activeTexture(e.TEXTURE3),e.bindTexture(e.TEXTURE_2D,this.tex.topoB),e.activeTexture(e.TEXTURE4),e.bindTexture(e.TEXTURE_2D,this.tex.topoC);for(let t=0;t<r;t++){let t=this.cur,n=1-this.cur;this._gpuSeed=this._gpuSeed+2654435769>>>0,e.uniform1ui(this.uni.seed,this._gpuSeed),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.tex.pos[t]),e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_2D,this.tex.vel[t]),e.bindFramebuffer(e.FRAMEBUFFER,this.fbo[n]),e.drawArrays(e.TRIANGLES,0,6),this.cur=n}e.bindFramebuffer(e.FRAMEBUFFER,null),this._dirty=!0,this.stepCount++,this.time+=t.dt}_startReadback(){let{gl:e}=this;this._fence||!this._dirty||(e.bindFramebuffer(e.FRAMEBUFFER,this.fbo[this.cur]),e.readBuffer(e.COLOR_ATTACHMENT0),e.bindBuffer(e.PIXEL_PACK_BUFFER,this.packBuf),e.readPixels(0,0,this.texW,this.texH,e.RGBA,e.FLOAT,0),e.bindBuffer(e.PIXEL_PACK_BUFFER,null),e.bindFramebuffer(e.FRAMEBUFFER,null),this._fence=e.fenceSync(e.SYNC_GPU_COMMANDS_COMPLETE,0),this._dirty=!1,e.flush())}_pollReadback(e=!1){let{gl:t,L:n}=this;if(!this._fence||t.clientWaitSync(this._fence,0,e?1e8:0)===t.TIMEOUT_EXPIRED)return!1;t.deleteSync(this._fence),this._fence=null,t.bindBuffer(t.PIXEL_PACK_BUFFER,this.packBuf),t.getBufferSubData(t.PIXEL_PACK_BUFFER,0,this._readBuf),t.bindBuffer(t.PIXEL_PACK_BUFFER,null);for(let e=0;e<n.n;e++)n.x[e]=this._readBuf[e*4],n.y[e]=this._readBuf[e*4+1];return!0}_sync(e=!0){this._startReadback(),this._pollReadback(e)}async flush(){this._pollReadback(!1),this._startReadback()}poses(){return this._sync(!1),super.poses()}outlines(){return this._sync(!1),super.outlines()}fillOutlines(e){return this._sync(!1),super.fillOutlines(e)}fillPoses(e){return this._sync(!1),super.fillPoses(e)}chargeWorld(){return this._sync(!1),super.chargeWorld()}free(){let e=this.gl;e&&this._fence&&(e.deleteSync(this._fence),this._fence=null),e?.deleteBuffer(this.packBuf),e?.getExtension(`WEBGL_lose_context`)?.loseContext()}};export{r as SoftEngineWebGL2};