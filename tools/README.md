# tools/

Headless utilities. All of them drive the same code the app runs, so numbers
and movies they produce reflect the shipped build.

| script | what it does |
| --- | --- |
| `capture.mjs` | Runs a scenario in headless Chromium and saves PNG frames + `stats.json`. `--stopRings N` ends the run once N closed rings persist. Always uses the in-thread engine (`?headless=1`) so stepping is deterministic. |
| `frames_to_gif.py` | Turns a frame directory into a palette-quantised animated GIF (`--fps`, `--stride`, `--colors`). Needs Pillow. |
| `bench.mjs` | Engine throughput (steps/s) at several molecule counts, in Node. `--engine rigid\|soft\|both`, `--counts 32,100,300`, `--json out.json`. |
| `sweep.mjs` | Parameter sweep scored on **time to assembly**, not steps/s. Rescales the annealing schedule with `dt` so a `dt` comparison isn't secretly a schedule change, and flags configurations whose integrator diverges. |

## Performance baselines

Recorded on a 4-core container (Node 22) so future changes have something to
be compared against. Reproduce with `npm run bench`.

Before the optimisation pass (commit `a293616`):

```
rigid n= 32 sites= 192    1791 steps/s
rigid n=100 sites= 600     543 steps/s
rigid n=300 sites=1800      92 steps/s
soft  n= 16 particles= 224  1397 steps/s
soft  n= 32 particles= 448   525 steps/s
soft  n= 64 particles= 896   183 steps/s
```

Phase split of a rigid step at that baseline — note how little of it was
actual physics:

| molecules | thermostat | site update | charge forces | impulses | Rapier |
| --- | --- | --- | --- | --- | --- |
| 32  | 8.2% | 9.2% | 27.4% | 47.2% | 7.4% |
| 100 | 5.2% | 7.5% | 48.0% | 35.7% | 3.5% |
| 300 | 1.9% | 2.9% | 82.7% | 10.3% | 2.1% |

Caveats when comparing runs: these are wall-clock measurements on a shared
4-core box, and they move by 15–20% depending on what else is running — take
ratios from a single quiet session rather than across sessions. GPU backends
cannot be benchmarked here at all, because headless Chromium falls back to
SwiftShader (software rasterisation), where WebGL2 measures ~25× *slower* than
the CPU backend. Use `window.__assemble.bench()` in a real browser for those.
