// Rigid-body backend on Rapier2D (WASM + SIMD).
//
// Rapier handles polygon contacts and integration; we add per-step
// screened-Coulomb forces at the charge sites and a Langevin heat bath
// (drag via Rapier's built-in damping, thermal kicks as random impulses
// scaled by sqrt(2 * gamma * m * kT * dt) per fluctuation–dissipation).

import RAPIER from '@dimforge/rapier2d-compat';
import { BaseEngine } from '../engine.js';
import { accumulateChargeForces } from '../electrostatics.js';
import { makeRng } from '../../rng.js';

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
      const flat = new Float32Array(spec.verts.flat());
      const col = RAPIER.ColliderDesc.convexHull(flat)
        .setRestitution(this.params.restitution)
        .setFriction(this.params.friction)
        .setDensity(this.params.density);
      this.world.createCollider(col, body);
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
    return this;
  }

  _updateSiteWorld() {
    let s = 0;
    for (let mi = 0; mi < this.bodies.length; mi++) {
      const body = this.bodies[mi];
      const p = body.translation();
      const a = body.rotation();
      const c = Math.cos(a);
      const sn = Math.sin(a);
      for (const [lx, ly] of this._siteLocal[mi]) {
        this.sites.x[s] = p.x + lx * c - ly * sn;
        this.sites.y[s] = p.y + lx * sn + ly * c;
        s++;
      }
    }
  }

  step() {
    this.applySchedule();
    const { dt, kT, gamma } = this.params;

    // thermal kicks (Langevin): random impulse ~ N(0, sqrt(2 gamma m kT dt))
    for (const body of this.bodies) {
      const m = body.mass();
      const I = body.effectiveAngularInertia?.() ?? m * 8; // fallback
      const sLin = Math.sqrt(2 * gamma * m * kT * dt);
      const sAng = Math.sqrt(2 * gamma * I * kT * dt);
      body.applyImpulse({ x: sLin * this.rng.gauss(), y: sLin * this.rng.gauss() }, true);
      body.applyTorqueImpulse(sAng * this.rng.gauss(), true);
      body.setLinearDamping(gamma);
      body.setAngularDamping(gamma);
    }

    // charge forces as impulses at world points
    this._updateSiteWorld();
    accumulateChargeForces(this.sites, this.params, this._fx, this._fy);
    let s = 0;
    for (let mi = 0; mi < this.bodies.length; mi++) {
      const body = this.bodies[mi];
      const n = this._siteLocal[mi].length;
      for (let k = 0; k < n; k++, s++) {
        const fx = this._fx[s];
        const fy = this._fy[s];
        if (fx === 0 && fy === 0) continue;
        body.applyImpulseAtPoint(
          { x: fx * dt, y: fy * dt },
          { x: this.sites.x[s], y: this.sites.y[s] },
          true,
        );
      }
    }

    this.world.timestep = dt;
    this.world.step();
    this.stepCount++;
    this.time += dt;
  }

  poses() {
    return this.bodies.map((b) => {
      const p = b.translation();
      return { x: p.x, y: p.y, angle: b.rotation() };
    });
  }

  outlines() {
    const out = [];
    for (let mi = 0; mi < this.bodies.length; mi++) {
      const b = this.bodies[mi];
      const p = b.translation();
      const a = b.rotation();
      const c = Math.cos(a);
      const sn = Math.sin(a);
      out.push(
        this.molecules[mi].spec.verts.map(([x, y]) => [
          p.x + x * c - y * sn,
          p.y + x * sn + y * c,
        ]),
      );
    }
    return out;
  }

  chargeWorld() {
    this._updateSiteWorld();
    return this.sites;
  }

  free() {
    this.world?.free();
  }
}
