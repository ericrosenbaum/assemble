// Soft-body engine entry: picks a compute backend (CPU reference,
// WebGL2 GPGPU, or WebGPU compute) and constructs the engine.

export async function detectBackends() {
  const names = ['cpu'];
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl && gl.getExtension('EXT_color_buffer_float')) names.push('webgl2');
  } catch {
    /* no webgl2 */
  }
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) names.push('webgpu');
    } catch {
      /* no webgpu */
    }
  }
  return names;
}

export async function createSoftEngine(opts, backend = 'auto') {
  const available = await detectBackends();
  let pick = backend;
  if (backend === 'auto') {
    pick = available.includes('webgl2') ? 'webgl2' : 'cpu';
  }
  if (!available.includes(pick)) pick = 'cpu';

  if (pick === 'webgpu') {
    const { SoftEngineWebGPU } = await import('./webgpu.js');
    try {
      const eng = new SoftEngineWebGPU(opts);
      await eng.ready;
      return eng;
    } catch (err) {
      console.warn('WebGPU backend failed, falling back to WebGL2/CPU:', err);
      pick = available.includes('webgl2') ? 'webgl2' : 'cpu';
    }
  }
  if (pick === 'webgl2') {
    const { SoftEngineWebGL2 } = await import('./webgl2.js');
    try {
      const eng = new SoftEngineWebGL2(opts);
      await eng.ready;
      return eng;
    } catch (err) {
      console.warn('WebGL2 backend failed, falling back to CPU:', err);
    }
  }
  const { SoftEngineCPU } = await import('./cpu.js');
  const eng = new SoftEngineCPU(opts);
  await eng.ready;
  return eng;
}
