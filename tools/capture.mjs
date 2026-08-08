// Headless capture harness: serves dist/, drives the app in headless
// Chromium via the window.__assemble API, and saves PNG frames + stats.
//
//   node tools/capture.mjs --scenario wedge-8 --engine rigid --steps 9000 \
//        --every 45 --size 540 --out out/run1 [--backend cpu] [--overrides '{"count":24}']

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
}
const cfg = {
  scenario: args.scenario ?? 'wedge-8',
  engine: args.engine ?? 'rigid',
  backend: args.backend ?? 'auto',
  steps: Number(args.steps ?? 9000),
  every: Number(args.every ?? 45),
  size: Number(args.size ?? 540),
  out: args.out ?? 'out/run',
  overrides: args.overrides ? JSON.parse(args.overrides) : {},
  // stop early once at least N closed rings have persisted for 15 frames
  stopRings: args.stopRings ? Number(args.stopRings) : 0,
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let p = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const outDir = path.resolve(root, cfg.out);
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: cfg.size + 40, height: cfg.size + 40 } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.error('[page]', m.text());
});
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(`http://127.0.0.1:${port}/?headless=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__assemble, { timeout: 15000 });

const init = await page.evaluate(
  (c) =>
    window.__assemble.init({
      scenario: c.scenario,
      engine: c.engine,
      backend: c.backend,
      overrides: c.overrides,
      canvasSize: c.size,
    }),
  cfg,
);
console.log('init:', JSON.stringify(init));

const nFrames = Math.ceil(cfg.steps / cfg.every);
const statsLog = [];
const t0 = Date.now();
let ringStreak = 0;
for (let f = 0; f <= nFrames; f++) {
  if (f > 0) await page.evaluate((n) => window.__assemble.stepN(n), cfg.every);
  const dataUrl = await page.evaluate(() => window.__assemble.frame());
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(path.join(outDir, `frame_${String(f).padStart(4, '0')}.png`), png);
  if (cfg.stopRings || f % 20 === 0 || f === nFrames) {
    const st = await page.evaluate(() => window.__assemble.stats());
    statsLog.push(st);
    if (f % 20 === 0 || f === nFrames)
      console.log(
        `frame ${f}/${nFrames}  step ${st.step}  T=${st.kT.toFixed(2)}  bonded=${st.bonded}  largest=${st.largest}  rings=[${st.rings}]`,
      );
    if (cfg.stopRings) {
      ringStreak = st.rings.length >= cfg.stopRings ? ringStreak + 1 : 0;
      if (ringStreak >= 15) {
        console.log(`early stop: ${st.rings.length} rings stable at frame ${f} (step ${st.step})`);
        break;
      }
    }
  }
}
const st = await page.evaluate(() => window.__assemble.stats());
fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify({ cfg, final: st, log: statsLog }, null, 2));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outDir}`);
console.log('final:', JSON.stringify(st));

await browser.close();
server.close();
