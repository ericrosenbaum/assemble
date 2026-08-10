// Rigid-body backend on Rapier2D (WASM + SIMD).
//
// Rapier handles polygon contacts and integration; we add per-step
// screened-Coulomb forces at the charge sites and a Langevin heat bath
// (drag via Rapier's built-in damping, thermal kicks as random impulses
// scaled by sqrt(2 * gamma * m * kT * dt) per fluctuation–dissipation).

import RAPIER from '@dimforge/rapier2d-compat';
import { BaseEngine } from '../engine.js';
import { accumulateChargeForcesCulled, buildMoleculeIndex, siteSpread } from '../electrostatics.js';
import { makeRng } from '../../rng.js';
import { decomposeConvex, isConvex } from '../../geometry/decompose.js';

// Convex pieces for a spec's collider(s), cached on the spec since several
// instances share it and decomposition is pure geometry.
function convexPieces(spec) {
  if (!spec._convexPieces) {
    spec._convexPieces = isConvex(spec.verts) ? [spec.verts] : decomposeConvex(spec.verts);
  }
  return spec._convexPieces;
}

let rapierReady = null;
export function initRapier() {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

export class RigidEngine extends BaseEngine {
  constructor(opts) {
    super(opts);
    this.kind = 'rigid';
    this.rng = makeRng(this.seed);
    this.ready = initRapier().then(() => this._build());
  }

  _build() {
    const { w, h } = this.box;
    this.world = new RAPIER.World({ x: 0, y: 0 });
    this.world.timestep = this.params.dt;

    // Rapier expresses its contact tolerances as fractions of `lengthUnit`,
    // which defaults to 1. Our molecules are ~10 units across, so the default
    // predicts contacts only 0.002 units ahead — while a molecule at thermal
    // speed covers ~0.008 units per step. Contacts were therefore discovered
    // *after* interpenetrating, and the solver turned that depth into
    // velocity: a docked monomer sitting quietly at |v| = 0.47 was launched to
    // 4.12 in a single step, with the electrostatic force on it only 0.06.
    // That was the sudden burst. Scaling the unit to the actual molecule size
    // removed it (10 seeds of dock-chain: peak KE 6.6x equilibrium -> 1.6x,
    // with the non-bursting seeds unchanged).
    this.world.integrationParameters.lengthUnit =
      (2 * this.specs.reduce((a, s) => a + s.boundingRadius(), 0)) / this.specs.length;

    // box walls: four fixed cuboids just outside the visible area
    const wall = (x, y, hx, hy) => {
      const b = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y));
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy).setRestitution(0.9).setFriction(0),
        b,
      );
    };
    const t = 2; // wall half-thickness
    wall(0, h / 2 + t, w / 2 + 2 * t, t);
    wall(0, -h / 2 - t, w / 2 + 2 * t, t);
    wall(w / 2 + t, 0, t, h / 2 + 2 * t);
    wall(-w / 2 - t, 0, t, h / 2 + 2 * t);

    this.bodies = [];
    this.molecules = [];
    // flat charge-site arrays for the force kernel
    let siteTotal = 0;
    for (const inst of this.instances) siteTotal += this.specs[inst.spec].charges.length;
    this.sites = {
      x: new Float64Array(siteTotal),
      y: new Float64Array(siteTotal),
      q: new Float64Array(siteTotal),
      mol: new Int32Array(siteTotal),
      count: siteTotal,
      nMol: this.instances.length,
    };
    this._siteLocal = []; // per molecule: [[lx, ly, q], ...]
    this._fx = new Float64Array(siteTotal);
    this._fy = new Float64Array(siteTotal);

    let s = 0;
    this.instances.forEach((inst, mi) => {
      const spec = this.specs[inst.spec];
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(inst.x, inst.y)
          .setRotation(inst.angle)
          .setLinearDamping(this.params.gamma)
          .setAngularDamping(this.params.gamma),
      );
      // Rapier's 2D colliders are convex, so a molecule with a pocket has to
      // be attached as several convex pieces or the pocket fills in and
      // nothing can dock. Convex outlines keep the single-hull path unchanged.
      for (const piece of convexPieces(spec)) {
        const col = RAPIER.ColliderDesc.convexHull(new Float32Array(piece.flat()))
          .setRestitution(this.params.restitution)
          .setFriction(this.params.friction)
          .setDensity(this.params.density);
        this.world.createCollider(col, body);
      }
      this.bodies.push(body);
      this.molecules.push({ spec, index: mi });
      const local = spec.chargeSites();
      this._siteLocal.push(local);
      for (const [, , q] of local) {
        this.sites.q[s] = q;
        this.sites.mol[s] = mi;
        s++;
      }
    });

    // Body properties that never change — reading them per step would cost a
    // WASM crossing each. localCom is the centre of mass in body frame; specs
    // are centroid-centred with uniform density so it is ~(0,0), but caching
    // the exact value keeps the batched torque origin correct regardless.
    const n = this.bodies.length;
    this._mass = new Float64Array(n);
    this._inertia = new Float64Array(n);
    this._localComX = new Float64Array(n);
    this._localComY = new Float64Array(n);
    for (let mi = 0; mi < n; mi++) {
      const body = this.bodies[mi];
      this._mass[mi] = body.mass();
      this._inertia[mi] = body.effectiveAngularInertia?.() ?? this._mass[mi] * 8;
      const lc = body.localCom?.();
      this._localComX[mi] = lc?.x ?? 0;
      this._localComY[mi] = lc?.y ?? 0;
    }
    this._px = new Float64Array(n);
    this._py = new Float64Array(n);
    this._cos = new Float64Array(n);
    this._sin = new Float64Array(n);
    this._poseStep = -1;
    this._appliedGamma = -1; // forces damping to be set on the first step
    // max over specs keeps the culling bound safe for mixed molecule sets
    const spread = Math.max(...this.specs.map((s) => siteSpread(s)));
    this._molIndex = buildMoleculeIndex(this.sites, n, spread);
    this._imp = { x: 0, y: 0 }; // reused, so no per-step object allocation
    return this;
  }

  // Reads each body's pose once per step and caches it, so the impulse pass
  // and the renderer don't pay for further WASM crossings (and the object
  // allocations Rapier's translation() returns).
  _updateSiteWorld() {
    let s = 0;
    for (let mi = 0; mi < this.bodies.length; mi++) {
      const body = this.bodies[mi];
      const p = body.translation();
      const a = body.rotation();
      const c = Math.cos(a);
      const sn = Math.sin(a);
      this._px[mi] = p.x;
      this._py[mi] = p.y;
      this._cos[mi] = c;
      this._sin[mi] = sn;
      for (const [lx, ly] of this._siteLocal[mi]) {
        this.sites.x[s] = p.x + lx * c - ly * sn;
        this.sites.y[s] = p.y + lx * sn + ly * c;
        s++;
      }
    }
    this._poseStep = this.stepCount;
  }

  step() {
    this.applySchedule();
    const { dt, kT, gamma } = this.params;

    // Damping is a body property, not a per-step force — only write it when
    // it actually changes.
    if (gamma !== this._appliedGamma) {
      for (const body of this.bodies) {
        body.setLinearDamping(gamma);
        body.setAngularDamping(gamma);
      }
      this._appliedGamma = gamma;
    }

    this._updateSiteWorld();
    accumulateChargeForcesCulled(this.sites, this.params, this._fx, this._fy, this._molIndex);

    // One applyImpulse + one applyTorqueImpulse per body, with the Langevin
    // kick folded in. applyImpulseAtPoint(J, p) is equivalent to applying J at
    // the centre of mass plus a torque (p - com) x J, so summing in JS first
    // is exact and collapses ~8 WASM crossings per body down to 2.
    const kick = Math.sqrt(2 * gamma * kT * dt);
    const imp = this._imp;
    let s = 0;
    for (let mi = 0; mi < this.bodies.length; mi++) {
      const body = this.bodies[mi];
      const c = this._cos[mi];
      const sn = this._sin[mi];
      // world centre of mass = translation + R * localCom (pose cached above)
      const comX = this._px[mi] + this._localComX[mi] * c - this._localComY[mi] * sn;
      const comY = this._py[mi] + this._localComX[mi] * sn + this._localComY[mi] * c;

      let ix = 0;
      let iy = 0;
      let torque = 0;
      const n = this._siteLocal[mi].length;
      for (let k = 0; k < n; k++, s++) {
        const jx = this._fx[s] * dt;
        const jy = this._fy[s] * dt;
        if (jx === 0 && jy === 0) continue;
        ix += jx;
        iy += jy;
        torque += (this.sites.x[s] - comX) * jy - (this.sites.y[s] - comY) * jx;
      }

      const sLin = kick * Math.sqrt(this._mass[mi]);
      const sAng = kick * Math.sqrt(this._inertia[mi]);
      imp.x = ix + sLin * this.rng.gauss();
      imp.y = iy + sLin * this.rng.gauss();
      body.applyImpulse(imp, true);
      body.applyTorqueImpulse(torque + sAng * this.rng.gauss(), true);
    }

    this.world.timestep = dt;
    this.world.step();
    this.stepCount++;
    this.time += dt;
  }

  // Refresh the cached pose only if it is stale for the current step.
  _syncPose() {
    if (this._poseStep !== this.stepCount) this._updateSiteWorld();
  }

  poses() {
    this._syncPose();
    return this.bodies.map((b, mi) => ({
      x: this._px[mi],
      y: this._py[mi],
      angle: Math.atan2(this._sin[mi], this._cos[mi]),
    }));
  }

  outlines() {
    this._syncPose();
    const out = [];
    for (let mi = 0; mi < this.bodies.length; mi++) {
      const px = this._px[mi];
      const py = this._py[mi];
      const c = this._cos[mi];
      const sn = this._sin[mi];
      out.push(
        this.molecules[mi].spec.verts.map(([x, y]) => [px + x * c - y * sn, py + x * sn + y * c]),
      );
    }
    return out;
  }

  // Allocation-free pose fill — see BaseEngine.fillPoses().
  fillPoses(out) {
    this._syncPose();
    let k = 0;
    for (let mi = 0; mi < this.bodies.length; mi++) {
      out[k++] = this._px[mi];
      out[k++] = this._py[mi];
      out[k++] = Math.atan2(this._sin[mi], this._cos[mi]);
    }
    return k;
  }

  // Allocation-free outline fill — see BaseEngine.fillOutlines().
  fillOutlines(out) {
    this._syncPose();
    let k = 0;
    for (let mi = 0; mi < this.bodies.length; mi++) {
      const px = this._px[mi];
      const py = this._py[mi];
      const c = this._cos[mi];
      const sn = this._sin[mi];
      const verts = this.molecules[mi].spec.verts;
      for (let v = 0; v < verts.length; v++) {
        const x = verts[v][0];
        const y = verts[v][1];
        out[k++] = px + x * c - y * sn;
        out[k++] = py + x * sn + y * c;
      }
    }
    return k;
  }

  chargeWorld() {
    this._syncPose();
    return this.sites;
  }

  free() {
    this.world?.free();
  }
}
