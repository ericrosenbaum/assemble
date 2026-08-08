// CPU-vs-GPU parity check: run the same T=0 scenario on both soft-engine
// backends and report the maximum particle position deviation. Used by
// test/parity.test.mjs; also callable from the console.

import { buildScenario } from '../../presets.js';
import { SoftEngineCPU } from './cpu.js';
import { SoftEngineWebGL2 } from './webgl2.js';

// Benchmark: engine steps/second per backend for a given molecule count.
export async function benchBackends({ backends = ['cpu', 'webgl2'], count = 40, steps = 120 } = {}) {
  const { createSoftEngine } = await import('./index.js');
  const box = Math.round(Math.sqrt(count) * 12);
  const sc = buildScenario('wedge-8', { count, boxW: box, boxH: box });
  const results = {};
  for (const be of backends) {
    try {
      const e = await createSoftEngine(
        { specs: sc.specs, instances: sc.instances, box: sc.box, params: { ...sc.params }, seed: 3, schedule: null },
        be,
      );
      if (!e.backendName.endsWith(be)) {
        results[be] = { error: 'unavailable (fell back to ' + e.backendName + ')' };
        e.free?.();
        continue;
      }
      // warmup
      for (let i = 0; i < 10; i++) e.step();
      e.outlines();
      const t0 = performance.now();
      for (let i = 0; i < steps; i++) e.step();
      e.outlines(); // force GPU sync
      await e.flush?.();
      const dt = (performance.now() - t0) / 1000;
      results[be] = { particles: e.L.n, stepsPerSec: Math.round(steps / dt) };
      e.free?.();
    } catch (err) {
      results[be] = { error: String(err) };
    }
  }
  return results;
}

export async function runParity({ steps = 40, count = 6 } = {}) {
  const sc = buildScenario('wedge-8', { count, boxW: 42, boxH: 42 });
  const mk = async (Cls) => {
    const e = new Cls({
      specs: sc.specs,
      instances: sc.instances,
      box: sc.box,
      params: { ...sc.params, kT: 0 },
      seed: 5,
      schedule: null,
    });
    await e.ready;
    return e;
  };
  const cpu = await mk(SoftEngineCPU);
  const gpu = await mk(SoftEngineWebGL2);
  for (let i = 0; i < steps; i++) {
    cpu.step();
    gpu.step();
  }
  gpu._sync();
  let maxDev = 0;
  for (let i = 0; i < cpu.L.n; i++) {
    maxDev = Math.max(maxDev, Math.hypot(cpu.L.x[i] - gpu.L.x[i], cpu.L.y[i] - gpu.L.y[i]));
  }
  gpu.free();
  return { particles: cpu.L.n, steps, maxDev, backend: gpu.backendName };
}
