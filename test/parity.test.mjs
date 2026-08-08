// Soft-engine backend parity: WebGL2 GPGPU must reproduce the CPU
// reference trajectory at T=0 within float32 tolerance.
// Requires a built app (npm run build) and headless Chromium.

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };

const server = http.createServer((req, res) => {
  let p = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] ?? 'application/octet-stream' });
    res.end(data);
  });
});
await new Promise((r) => server.listen(0, r));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--use-angle=swiftshader'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/?headless=1`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__assemble, { timeout: 15000 });

const r = await page.evaluate(() => window.__assemble.parity({ steps: 40 }));
console.log('parity:', JSON.stringify(r));
await browser.close();
server.close();

if (!(r.maxDev < 0.05)) {
  console.error(`FAIL: max deviation ${r.maxDev} exceeds tolerance 0.05`);
  process.exit(1);
}
console.log(`ok: webgl2 matches cpu within ${r.maxDev.toExponential(2)} over ${r.steps} steps`);
