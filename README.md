# assemble

A 2D molecular self-assembly simulator that runs entirely in the browser.
Design molecules as polygons with electrostatic charges on their edges, drop
many copies into a thermal heat bath, and watch ordered structures — rings,
chains, lattices — assemble themselves out of random motion and stickiness.

A modern successor to the Molecular Workbench self-assembly activity
(["Molecular Self-Assembly"](https://concord.org), @Concord, Fall 2005): the
classic demo where wedge-shaped monomers with `+` and `−` charges on their
sloped sides spontaneously form rings, like a cross-section of a microtubule
assembling from tubulin.

![two rings self-assembling](results/wedge8_two_rings_rigid.gif)

*40 wedge monomers annealing into two closed 8-rings (rigid-body engine).*

## Running it

```bash
npm install
npm run dev        # local dev server
npm run build      # static site in dist/ — deployable to GitHub Pages
```

Everything is client-side; there is no server component.

## Two dynamics engines

Both engines implement the same interface (`src/sim/engine.js`) and share
the same screened-Coulomb electrostatics and Langevin heat bath, so you can
switch between them live in the UI:

- **Rigid-body** (`src/sim/rigid/rapier.js`) — molecules are rigid convex
  polygons simulated by [Rapier2D](https://rapier.rs) (Rust → WASM + SIMD).
  Rapier handles contacts and integration; we add charge-site forces as
  impulses and thermal noise per fluctuation–dissipation. Fast and crisp —
  the workhorse.
- **Soft-body** (`src/sim/soft/`) — the original Molecular Workbench style:
  each molecule is particles along its perimeter plus a hub at the centroid,
  joined by stiff springs (a wheel graph, which is rigid in 2D but stays
  slightly squishy). Between molecules: WCA contact repulsion and screened
  Coulomb on charged particles. Opposite-charge "sticky sites" are exempt
  from contact repulsion so they can bind at close range, like patchy
  colloids.

![soft engine ring](results/wedge8_ring_soft.gif)

*The same wedge experiment on the soft-body engine: joints zip up one
sticky-site pair at a time and the finished ring is charmingly organic,
where the rigid engine's rings are crisp octagons.*

## Hardware acceleration

The soft engine's per-particle forces are embarrassingly parallel, so it has
three interchangeable compute backends (`auto` picks the best available):

| backend | where it runs | status |
| --- | --- | --- |
| CPU (typed arrays + spatial hash) | everywhere | reference implementation |
| WebGL2 GPGPU (`soft/webgl2.js`) | any GPU incl. iOS Safari | tested: matches CPU to 3e-5 over 40 steps (`test/parity.test.mjs`) |
| WebGPU compute (`soft/webgpu.js`) | modern browsers (iOS 26+, Chrome, Edge) | experimental: line-for-line WGSL port of the WebGL2 kernel; feature-detected with fallback |

The WebGL2 backend packs particle state into RGBA32F textures and evaluates
springs + all-pairs WCA/Coulomb + Langevin integration in a fragment shader
with ping-pong FBOs (MRT writes position and velocity together). Positions
are read back at most once per rendered frame. The WebGPU backend is the
same kernel as WGSL compute over storage buffers, with async readback.

The rigid engine's acceleration comes from Rapier's WASM+SIMD build — its
few hundred charge sites are cheaper on the CPU than a GPU round-trip.

Honest benchmark note: in the headless CI container, WebGL2 runs on
SwiftShader (software rasterizer) and is *slower* than the CPU backend —
GPU backends only pay off on real GPUs. Run `window.__assemble.bench()` in
the console to measure your machine.

## The wedge-ring experiment

`wedge(nRing)` builds a trapezoid whose sloped sides each tilt by `π/nRing`,
so `nRing` copies mate flush and close into a ring (verified to machine
precision by `test/geometry.test.mjs`). Getting from "wedges attract" to
"wedges reliably form rings" took a series of instructive failures:

| | |
| --- | --- |
| ![zigzag failure](results/failure_zigzag_chains.gif) | **Zigzag chains.** With symmetric charge rows (the 2005 layout) and strong binding, a 180°-flipped wedge that *slides* along the face can pair off charges almost as well as a correct one, and at 300× kT nothing ever un-binds. S-shaped chains freeze in. |
| ![tangle failure](results/failure_lateral_tangle.gif) | **Lateral tangles.** Long screening lengths make charges reach past their own face — chains glue to each other side-by-side into a 23-molecule clump. |
| ![first ring](results/wedge8_first_ring_rigid.gif) | **First closed ring.** Equal charges at Golomb-ruler positions (all pairwise spacings distinct), short screening, and a long anneal in the selective temperature window. |

What ended up mattering, in order:

1. **Flip symmetry.** A wedge rotated 180° presents its *like-signed* face
   to a growing chain, so equal same-sign charges per face make flipped
   (zigzag) joints purely repulsive. (Adding an opposite-sign "cap" charge —
   tried along the way — accidentally re-enabled zigzags by giving flipped
   faces anchor points at both ends.)
2. **Slide registration.** A face that slides along its partner can still
   align some charge pairs. Placing charges at Golomb-ruler positions
   (`t = 0.2, 0.45, 0.8` — every pairwise spacing distinct) guarantees any
   misregistration aligns at most *one* pair (~12 energy units) while flush
   mating aligns all three (~42).
3. **The selective temperature window.** Anneal by holding where single-pair
   mistakes break (≈7 kT) but full-face bonds hold (≈25 kT) — `kT ≈ 1.7`
   with the tuned constants — then cool slowly, and stop the quench warm
   (`kT ≈ 0.7`) so leftover fragments don't glom onto finished rings.
4. **Low contact friction**, so docking faces can slide into registration.

The tuned constants live in `src/presets.js`.

## Designing your own molecules

The **molecule designer** panel in the UI lets you drag polygon corners, add
corners, and tap edges to place `+`/`−` charge sites, then run copies of
your design in the bath. Shapes serialize to/from JSON. (The rigid engine
takes the convex hull of concave shapes; the soft engine handles them
as-is.)

## Headless capture & experiments

The same build runs headless for parameter sweeps and movie-making:

```bash
npm run build
node tools/capture.mjs --scenario wedge-8 --engine rigid \
  --steps 140000 --every 700 --out out/run1 --stopRings 2 \
  --overrides '{"count":40,"schedule":{"Tstart":1.7,"Tend":0.7,"holdSteps":120000,"coolSteps":60000}}'
python3 tools/frames_to_gif.py out/run1 out/run1.gif --fps 14 --stride 2
```

`--stopRings N` ends the run once N closed rings persist. Ring detection is
a bond-graph cycle check (`src/sim/analysis.js`), also shown live in the UI.

## Tests

```bash
npm test                     # wedge ring-closure geometry (node, no browser)
node test/parity.test.mjs    # CPU vs WebGL2 physics parity (headless Chromium)
```
