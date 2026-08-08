// Simulation worker: owns the engine and steps it independently of the
// render loop.
//
// Previously the sim was driven from requestAnimationFrame, which capped it at
// stepsPerFrame x 60 fps (1200 steps/s) no matter how fast the engine ran.
// Here the worker steps in time-budgeted slices and posts a snapshot of just
// the geometry the renderer needs, so simulation rate and frame rate are
// decoupled entirely.
//
// Snapshot buffers ping-pong: the main thread transfers them back after
// drawing. If none is free (renderer is behind) the worker keeps simulating
// and skips the post rather than allocating or stalling.

import { buildScenario } from '../presets.js';
import { RigidEngine } from './rigid/rapier.js';
import { createSoftEngine } from './soft/index.js';
import { stats } from './analysis.js';

let engine = null;
let running = false;
let maxSpeed = false;
let sliceMs = 12; // work per slice when not in max-speed mode
let freeBuffers = [];
let statsEvery = 200; // ms
let lastStats = 0;
let vertTotal = 0;
let vertCounts = null;
let loopHandle = null;

// steps/s measured over a sliding window
let rateSteps = 0;
let rateStart = 0;
let stepsPerSec = 0;

function buildSnapshotLayout() {
  const outlines = engine.outlines();
  vertCounts = new Int32Array(outlines.length);
  vertTotal = 0;
  outlines.forEach((poly, i) => {
    vertCounts[i] = poly.length;
    vertTotal += poly.length;
  });
  const sites = engine.chargeWorld();
  freeBuffers = [newBuffer(sites.count), newBuffer(sites.count)];
  return { vertCounts, sites };
}

function newBuffer(siteCount) {
  return {
    outlineXY: new Float32Array(vertTotal * 2),
    chargeXY: new Float32Array(siteCount * 2),
  };
}

function fillSnapshot(buf) {
  const outlines = engine.outlines();
  const oxy = buf.outlineXY;
  let k = 0;
  for (const poly of outlines) {
    for (const [x, y] of poly) {
      oxy[k++] = x;
      oxy[k++] = y;
    }
  }
  const sites = engine.chargeWorld();
  const cxy = buf.chargeXY;
  for (let i = 0, j = 0; i < sites.count; i++) {
    cxy[j++] = sites.x[i];
    cxy[j++] = sites.y[i];
  }
}

function post(force = false) {
  const buf = freeBuffers.pop();
  if (!buf) return; // renderer is behind; keep simulating
  fillSnapshot(buf);

  let st = null;
  const now = performance.now();
  if (force || now - lastStats > statsEvery) {
    st = stats(engine.chargeWorld());
    lastStats = now;
  }

  self.postMessage(
    {
      type: 'snapshot',
      outlineXY: buf.outlineXY,
      chargeXY: buf.chargeXY,
      step: engine.stepCount,
      kT: engine.params.kT,
      stepsPerSec,
      stats: st,
    },
    [buf.outlineXY.buffer, buf.chargeXY.buffer],
  );
}

function measureRate(n) {
  rateSteps += n;
  const now = performance.now();
  if (rateStart === 0) rateStart = now;
  const dt = now - rateStart;
  if (dt > 500) {
    stepsPerSec = Math.round((rateSteps / dt) * 1000);
    rateSteps = 0;
    rateStart = now;
  }
}

async function loop() {
  if (!running || !engine) return;
  const budget = maxSpeed ? 32 : sliceMs;
  const t0 = performance.now();
  let n = 0;
  // Check the clock every few steps rather than every step — performance.now()
  // is not free relative to a single step at small molecule counts.
  do {
    for (let i = 0; i < 8; i++) engine.step();
    n += 8;
  } while (performance.now() - t0 < budget);
  await engine.flush?.(); // async GPU backends
  measureRate(n);
  post();
  // Yield to the event loop so control messages are processed between slices.
  loopHandle = setTimeout(loop, 0);
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init': {
      const { scenario, engineKind, backend, overrides } = msg;
      const sc = buildScenario(scenario, overrides ?? {});
      const opts = {
        specs: sc.specs,
        instances: sc.instances,
        box: sc.box,
        params: engineKind === 'soft' ? { ...sc.params, ...sc.paramsSoft } : sc.params,
        seed: sc.seed,
        schedule: sc.schedule,
      };
      engine?.free?.();
      engine = engineKind === 'rigid' ? new RigidEngine(opts) : await createSoftEngine(opts, backend);
      await engine.ready;
      const { sites } = buildSnapshotLayout();
      rateStart = 0;
      rateSteps = 0;
      stepsPerSec = 0;
      self.postMessage({
        type: 'ready',
        box: sc.box,
        // static data the renderer needs once
        specs: sc.specs.map((s) => s.toJSON()),
        instanceSpec: sc.instances.map((i) => i.spec),
        vertCounts,
        chargeQ: Float32Array.from(sites.q.subarray(0, sites.count)),
        chargeMol: Int32Array.from(sites.mol.subarray(0, sites.count)),
        molecules: sc.instances.length,
        backendName: engine.backendName ?? engine.kind,
      });
      post(true);
      break;
    }
    case 'recycle':
      freeBuffers.push({ outlineXY: msg.outlineXY, chargeXY: msg.chargeXY });
      break;
    case 'run':
      if (!running) {
        running = true;
        loop();
      }
      break;
    case 'pause':
      running = false;
      clearTimeout(loopHandle);
      break;
    case 'maxSpeed':
      maxSpeed = msg.value;
      break;
    case 'params':
      if (engine) {
        Object.assign(engine.params, msg.params);
        if (msg.clearSchedule) engine.schedule = null;
      }
      break;
    case 'anneal':
      if (engine) {
        engine.stepCount = 0;
        engine.schedule = msg.schedule ?? engine.schedule;
      }
      break;
    case 'stats':
      post(true);
      break;
    default:
      break;
  }
};
