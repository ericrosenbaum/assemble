// App shell: wires scenarios, engines, renderer, controls, and exposes a
// deterministic driver API (window.__assemble) for the headless capture
// harness in tools/capture.mjs.

import { buildScenario, SCENARIOS } from './presets.js';
import { RigidEngine } from './sim/rigid/rapier.js';
import { createSoftEngine, detectBackends } from './sim/soft/index.js';
import { WorkerSim } from './sim/simclient.js';
import { Renderer } from './render/draw.js';
import { stats } from './sim/analysis.js';

const qs = new URLSearchParams(location.search);
const headless = qs.get('headless') === '1';
// The headless capture harness drives stepping synchronously and needs
// deterministic control of when steps happen, so it always runs in-thread.
const useWorker = !headless && qs.get('worker') !== '0' && typeof Worker !== 'undefined';

const el = (id) => document.getElementById(id);
const canvas = el('view');

const state = {
  engine: null,
  renderer: null,
  scenario: null,
  running: false,
  engineKind: qs.get('engine') || 'rigid',
  backend: qs.get('backend') || 'auto',
  scenarioName: qs.get('scenario') || 'wedge-8',
  stepsPerFrame: 6,
  overrides: {},
  maxSpeed: false,
};

for (const [name, s] of Object.entries(SCENARIOS)) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = s.label;
  el('scenario').appendChild(opt);
}
el('scenario').value = state.scenarioName;
el('engine').value = state.engineKind;
el('backend').value = state.backend;

async function makeEngine() {
  const sc = buildScenario(state.scenarioName, state.overrides);
  state.scenario = sc;

  if (useWorker) {
    const sim = new WorkerSim();
    await sim.init({
      scenario: state.scenarioName,
      engineKind: state.engineKind,
      backend: state.backend,
      overrides: state.overrides,
    });
    // The worker drives its own pace; just repaint whenever a snapshot lands.
    sim.onSnapshot(() => {
      draw();
      updateStats();
    });
    state.engine = sim;
    state.renderer = new Renderer(canvas, sc.box);
    el('count').value = String(sim.instances.length);
    draw();
    updateStats();
    if (state.running) sim.run();
    return sim;
  }

  const opts = {
    specs: sc.specs,
    instances: sc.instances,
    box: sc.box,
    params: state.engineKind === 'soft' ? { ...sc.params, ...sc.paramsSoft } : sc.params,
    seed: sc.seed,
    schedule: sc.schedule,
  };
  const engine =
    state.engineKind === 'rigid' ? new RigidEngine(opts) : await createSoftEngine(opts, state.backend);
  await engine.ready;
  state.engine = engine;
  state.renderer = new Renderer(canvas, sc.box);
  el('count').value = String(sc.instances.length);
  draw();
  updateStats();
  return engine;
}

function draw() {
  if (state.engine && state.renderer) state.renderer.draw(state.engine);
}

function updateStats() {
  if (!state.engine) return;
  // In worker mode the stats come with the snapshot (computed off the main
  // thread); in-thread we compute them here.
  const st = state.engine.stats ?? stats(state.engine.chargeWorld());
  if (!st) return;
  // Report whichever structure this scenario actually builds: rings for the
  // polygon family, stars for the hub-and-arm ones.
  const tally = (arr, unit) => {
    const counts = new Map();
    for (const v of arr) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts]
      .sort((a, b) => b[0] - a[0])
      .map(([v, n]) => (n > 1 ? `${n}×${v}-${unit}` : `${v}-${unit}`))
      .join(', ');
  };
  const rings = st.rings.length
    ? `rings: ${tally(st.rings, 'ring')}`
    : st.stars?.length
      ? `stars: ${tally(st.stars, 'arm')}`
      : 'rings: none yet';
  const rate = state.engine.stepsPerSec
    ? `   ${state.engine.stepsPerSec.toLocaleString()} steps/s`
    : '';
  el('stats').textContent =
    `${rings}\n` +
    `bonded molecules: ${st.bonded}/${state.engine.instances.length}   clusters: ${st.clusters}\n` +
    `largest cluster: ${st.largest}   backend: ${state.engine.backendName ?? state.engine.kind}${rate}`;
  el('tempVal').textContent = state.engine.params.kT.toFixed(2);
  el('temp').value = String(state.engine.params.kT);
}

let statTick = 0;
function loop() {
  if (!state.running) return;
  const n = state.stepsPerFrame;
  for (let i = 0; i < n; i++) state.engine.step();
  draw();
  if (++statTick % 10 === 0) updateStats();
  requestAnimationFrame(loop);
}

// ---- controls ----
el('play').addEventListener('click', () => {
  state.running = !state.running;
  el('play').textContent = state.running ? '⏸ pause' : '▶ run';
  if (state.engine?.kind === 'worker') {
    state.running ? state.engine.run() : state.engine.pause();
  } else if (state.running) {
    requestAnimationFrame(loop);
  }
});
el('maxSpeed').addEventListener('change', (e) => {
  state.maxSpeed = e.target.checked;
  state.engine?.setMaxSpeed?.(state.maxSpeed);
  // in-thread mode has no worker to run flat out; widen the per-frame batch
  el('speed').disabled = state.maxSpeed;
});
el('reset').addEventListener('click', async () => {
  state.engine?.free?.();
  await makeEngine();
});
el('anneal').addEventListener('click', () => {
  if (!state.engine) return;
  if (state.engine.kind === 'worker') {
    state.engine.anneal(state.scenario.def.schedule);
  } else {
    state.engine.stepCount = 0;
    state.engine.schedule = state.scenario.schedule;
  }
});
el('scenario').addEventListener('change', async (e) => {
  state.scenarioName = e.target.value;
  state.overrides = {};
  state.engine?.free?.();
  await makeEngine();
});
el('engine').addEventListener('change', async (e) => {
  state.engineKind = e.target.value;
  state.engine?.free?.();
  await makeEngine();
});
el('backend').addEventListener('change', async (e) => {
  state.backend = e.target.value;
  if (state.engineKind === 'soft') {
    state.engine?.free?.();
    await makeEngine();
  }
});
el('count').addEventListener('change', async (e) => {
  state.overrides.count = Math.max(2, Math.min(120, Number(e.target.value) | 0));
  state.engine?.free?.();
  await makeEngine();
});
el('temp').addEventListener('input', (e) => {
  if (!state.engine) return;
  const kT = Number(e.target.value);
  if (state.engine.kind === 'worker') {
    state.engine.setParams({ kT }, { clearSchedule: true }); // manual overrides annealing
  } else {
    state.engine.schedule = null;
    state.engine.params.kT = kT;
  }
  el('tempVal').textContent = kT.toFixed(2);
});
el('speed').addEventListener('input', (e) => {
  state.stepsPerFrame = Number(e.target.value);
  el('speedVal').textContent = `${state.stepsPerFrame}×`;
});

detectBackends().then((names) => {
  el('backendHint').textContent = `available compute: ${names.join(', ')}`;
});

// ---- designer (lazy) ----
el('designerDetails').addEventListener('toggle', async (e) => {
  if (e.target.open && !e.target._loaded) {
    e.target._loaded = true;
    const { mountDesigner } = await import('./designer/editor.js');
    mountDesigner(el('designer-host'), {
      onUse: async (spec, count) => {
        state.overrides = {};
        state.scenarioName = 'custom';
        SCENARIOS['custom'] = {
          label: 'custom molecule',
          config: {
            ...SCENARIOS['wedge-8'].config,
            spec: () => spec,
            count,
          },
        };
        if (![...el('scenario').options].some((o) => o.value === 'custom')) {
          const opt = document.createElement('option');
          opt.value = 'custom';
          opt.textContent = 'custom molecule';
          el('scenario').appendChild(opt);
        }
        el('scenario').value = 'custom';
        state.engine?.free?.();
        await makeEngine();
      },
    });
  }
});

// ---- headless driver API ----
window.__assemble = {
  async init(cfg = {}) {
    if (cfg.scenario) state.scenarioName = cfg.scenario;
    if (cfg.engine) state.engineKind = cfg.engine;
    if (cfg.backend) state.backend = cfg.backend;
    state.overrides = cfg.overrides ?? {};
    if (cfg.canvasSize) {
      canvas.width = cfg.canvasSize;
      canvas.height = cfg.canvasSize;
    }
    state.engine?.free?.();
    await makeEngine();
    return { ok: true, molecules: state.engine.instances.length };
  },
  async stepN(n) {
    for (let i = 0; i < n; i++) state.engine.step();
    await state.engine.flush?.(); // async backends (WebGPU) sync positions
    draw();
    return state.engine.stepCount;
  },
  frame() {
    return canvas.toDataURL('image/png');
  },
  stats() {
    updateStats();
    const sc = state.scenario;
    if (sc && sc.specs.length > 1) {
      return {
        ...stats(state.engine.chargeWorld(), {
          specOf: sc.instances.map((i) => i.spec),
          nSpecies: sc.specs.length,
        }),
        speciesNames: sc.specs.map((s) => s.name),
        step: state.engine.stepCount,
        kT: state.engine.params.kT,
      };
    }
    return { ...stats(state.engine.chargeWorld()), step: state.engine.stepCount, kT: state.engine.params.kT };
  },
  async parity(opts) {
    const { runParity } = await import('./sim/soft/parity.js');
    return runParity(opts);
  },
  async bench(opts) {
    const { benchBackends } = await import('./sim/soft/parity.js');
    return benchBackends(opts);
  },
};

if (!headless) {
  // start running by default so the app feels alive
  state.running = true;
  el('play').textContent = '⏸ pause';
  makeEngine().then((engine) => {
    if (engine.kind === 'worker') engine.run();
    else requestAnimationFrame(loop);
  });
}
