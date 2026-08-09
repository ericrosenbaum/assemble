// Molecule designer: edit a polygon, paint +/- charges on its edges, then
// drop copies into the simulation. Touch-friendly (pointer events).

import { MoleculeSpec, wedge, facePair, tiler, hub, rod } from '../shapes.js';

// Each starter is a working design, so editing one is a starting point rather
// than a blank page. The polygon entries are labelled with what they build:
// for a regular n-gon with its + and − faces k edges apart, the ring size is
// m = 2n/(n-2k) (see src/shapes.js).
const STARTERS = {
  'wedge → 8-ring': () => wedge({ nRing: 8 }),
  'wedge → 6-ring': () => wedge({ nRing: 6 }),
  'square → 2×2 block': () => facePair({ n: 4, k: 1 }),
  'square → sheet': () => tiler({ n: 4 }),
  'hexagon → trimer': () => facePair({ n: 6, k: 1 }),
  'hexagon → 6-ring': () => facePair({ n: 6, k: 2 }),
  'hexagon → fibre': () => facePair({ n: 6, k: 3 }),
  'hexagon → honeycomb': () => tiler({ n: 6 }),
  'triangle → 6-rosette': () => facePair({ n: 3, k: 1 }),
  'pentagon → 10-ring': () => facePair({ n: 5, k: 2 }),
  // hub-and-arm: pair these two to build stars
  'triangle hub (+ all faces)': () => hub({ n: 3 }),
  'rod arm (− one end)': () => rod({}),
  'blank square': () =>
    new MoleculeSpec({
      name: 'square',
      verts: [
        [-4, -4],
        [4, -4],
        [4, 4],
        [-4, 4],
      ],
      charges: [],
    }),
};

export function mountDesigner(host, { onUse }) {
  host.innerHTML = `
    <style>
      .dz-wrap { display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }
      .dz-wrap canvas { background: #10161d; border-radius: 8px; touch-action: none; width: 100%; }
      .dz-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .dz-row button, .dz-row select { flex: initial; padding: 5px 9px; font-size: 12.5px; }
      .dz-row button.active { background: #e8b04b; color: #14202e; border-color: #e8b04b; }
      .dz-hint { color: #8b98a8; font-size: 11.5px; line-height: 1.4; }
      .dz-json { width: 100%; height: 54px; background: #0d1117; color: #dbe4ee; border: 1px solid #2a3542; border-radius: 6px; font-size: 10.5px; font-family: ui-monospace, monospace; }
    </style>
    <div class="dz-wrap">
      <div class="dz-row">
        start from
        <select class="dz-starter">${Object.keys(STARTERS)
          .map((k) => `<option>${k}</option>`)
          .join('')}</select>
      </div>
      <canvas class="dz-canvas" width="272" height="272"></canvas>
      <div class="dz-row">
        <button data-mode="move" class="active">move</button>
        <button data-mode="plus">+ charge</button>
        <button data-mode="minus">− charge</button>
        <button data-mode="erase">erase</button>
        <button data-mode="vertex">add corner</button>
      </div>
      <div class="dz-hint">move: drag corners · charge modes: tap an edge to place a site · erase: tap a charge or corner · add corner: tap an edge</div>
      <div class="dz-row">
        copies <input class="dz-count" type="number" min="2" max="120" value="24" style="width:64px" />
        <button class="dz-use">▶ simulate</button>
      </div>
      <textarea class="dz-json" spellcheck="false"></textarea>
      <div class="dz-row"><button class="dz-load">load JSON</button><button class="dz-copy">copy JSON</button></div>
    </div>`;

  const canvas = host.querySelector('.dz-canvas');
  const ctx = canvas.getContext('2d');
  const jsonBox = host.querySelector('.dz-json');
  let spec = STARTERS['wedge → 8-ring']();
  let verts = spec.verts.map((v) => [...v]);
  let charges = spec.charges.map((c) => ({ ...c }));
  let mode = 'move';
  let dragging = -1;

  const S = 13; // px per world unit
  const cx = () => canvas.width / 2;
  const cy = () => canvas.height / 2;
  const toPx = ([x, y]) => [cx() + x * S, cy() - y * S];
  const toWorld = (px, py) => [(px - cx()) / S, (cy() - py) / S];

  function chargePos(c) {
    const [x1, y1] = verts[c.edge % verts.length];
    const [x2, y2] = verts[(c.edge + 1) % verts.length];
    return [x1 + c.t * (x2 - x1), y1 + c.t * (y2 - y1)];
  }

  function draw() {
    ctx.fillStyle = '#10161d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // polygon
    ctx.beginPath();
    verts.forEach((v, i) => {
      const [X, Y] = toPx(v);
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.closePath();
    ctx.fillStyle = '#e8b04bcc';
    ctx.fill();
    ctx.strokeStyle = '#00000088';
    ctx.lineWidth = 2;
    ctx.stroke();
    // vertex handles
    for (const v of verts) {
      const [X, Y] = toPx(v);
      ctx.beginPath();
      ctx.arc(X, Y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#dbe4ee';
      ctx.fill();
    }
    // charges
    for (const c of charges) {
      const [X, Y] = toPx(chargePos(c));
      ctx.beginPath();
      ctx.arc(X, Y, 6, 0, Math.PI * 2);
      ctx.fillStyle = c.q > 0 ? '#ff5c5c' : '#5ca8ff';
      ctx.fill();
      ctx.strokeStyle = '#000000aa';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(X - 3, Y);
      ctx.lineTo(X + 3, Y);
      if (c.q > 0) {
        ctx.moveTo(X, Y - 3);
        ctx.lineTo(X, Y + 3);
      }
      ctx.stroke();
    }
    syncJson();
  }

  function syncJson() {
    jsonBox.value = JSON.stringify({ name: 'custom', verts, charges });
  }

  function nearestVertex(px, py, rad = 14) {
    let best = -1;
    let bd = rad * rad;
    verts.forEach((v, i) => {
      const [X, Y] = toPx(v);
      const d = (X - px) ** 2 + (Y - py) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  function nearestEdge(px, py) {
    const [wx, wy] = toWorld(px, py);
    let best = { edge: -1, t: 0, d: 1.2 };
    for (let e = 0; e < verts.length; e++) {
      const [x1, y1] = verts[e];
      const [x2, y2] = verts[(e + 1) % verts.length];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      let t = ((wx - x1) * dx + (wy - y1) * dy) / len2;
      t = Math.max(0.05, Math.min(0.95, t));
      const ex = x1 + t * dx - wx;
      const ey = y1 + t * dy - wy;
      const d = Math.hypot(ex, ey);
      if (d < best.d) best = { edge: e, t, d };
    }
    return best.edge >= 0 ? best : null;
  }

  function nearestCharge(px, py, rad = 12) {
    let best = -1;
    let bd = rad * rad;
    charges.forEach((c, i) => {
      const [X, Y] = toPx(chargePos(c));
      const d = (X - px) ** 2 + (Y - py) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  canvas.addEventListener('pointerdown', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) * canvas.width) / rect.width;
    const py = ((ev.clientY - rect.top) * canvas.height) / rect.height;
    if (mode === 'move') {
      dragging = nearestVertex(px, py);
      canvas.setPointerCapture(ev.pointerId);
    } else if (mode === 'plus' || mode === 'minus') {
      const hit = nearestEdge(px, py);
      if (hit) charges.push({ edge: hit.edge, t: hit.t, q: mode === 'plus' ? 1 : -1 });
    } else if (mode === 'erase') {
      const ci = nearestCharge(px, py);
      if (ci >= 0) charges.splice(ci, 1);
      else {
        const vi = nearestVertex(px, py);
        if (vi >= 0 && verts.length > 3) {
          charges = charges.filter((c) => c.edge !== vi && c.edge !== (vi - 1 + verts.length) % verts.length);
          charges.forEach((c) => {
            if (c.edge > vi) c.edge--;
          });
          verts.splice(vi, 1);
        }
      }
    } else if (mode === 'vertex') {
      const hit = nearestEdge(px, py);
      if (hit) {
        const [x1, y1] = verts[hit.edge];
        const [x2, y2] = verts[(hit.edge + 1) % verts.length];
        verts.splice(hit.edge + 1, 0, [x1 + hit.t * (x2 - x1), y1 + hit.t * (y2 - y1)]);
        charges.forEach((c) => {
          if (c.edge > hit.edge) c.edge++;
        });
      }
    }
    draw();
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (mode !== 'move' || dragging < 0) return;
    const rect = canvas.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) * canvas.width) / rect.width;
    const py = ((ev.clientY - rect.top) * canvas.height) / rect.height;
    verts[dragging] = toWorld(px, py);
    draw();
  });
  canvas.addEventListener('pointerup', () => (dragging = -1));

  for (const btn of host.querySelectorAll('[data-mode]')) {
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode;
      host.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  }
  host.querySelector('.dz-starter').addEventListener('change', (e) => {
    const s = STARTERS[e.target.value]();
    verts = s.verts.map((v) => [...v]);
    charges = s.charges.map((c) => ({ ...c }));
    draw();
  });
  host.querySelector('.dz-use').addEventListener('click', () => {
    try {
      const spec = new MoleculeSpec({ name: 'custom', verts, charges });
      onUse(spec, Number(host.querySelector('.dz-count').value) || 24);
    } catch (err) {
      alert('invalid shape: ' + err.message);
    }
  });
  host.querySelector('.dz-load').addEventListener('click', () => {
    try {
      const obj = JSON.parse(jsonBox.value);
      verts = obj.verts.map((v) => [...v]);
      charges = (obj.charges ?? []).map((c) => ({ ...c }));
      draw();
    } catch (err) {
      alert('bad JSON: ' + err.message);
    }
  });
  host.querySelector('.dz-copy').addEventListener('click', () => {
    navigator.clipboard?.writeText(jsonBox.value);
  });

  draw();
}
