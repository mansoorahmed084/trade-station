// Draw the desktop app's icon (an original design: candles and a rising line on a dark tile),
// render it with headless Chrome and turn it into a macOS .icns with the system's sips and iconutil.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'apps', 'desktop', 'build-resources');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2330"/><stop offset="1" stop-color="#0b0e13"/></linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4c8dff" stop-opacity="0.15"/><stop offset="1" stop-color="#4c8dff"/></linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="none" stroke="#2a3443" stroke-width="6"/>
  <g stroke-linecap="round">
    <line x1="290" y1="420" x2="290" y2="760" stroke="#ef5350" stroke-width="16"/>
    <rect x="245" y="480" width="90" height="200" rx="14" fill="#ef5350"/>
    <line x1="460" y1="330" x2="460" y2="690" stroke="#26a69a" stroke-width="16"/>
    <rect x="415" y="390" width="90" height="230" rx="14" fill="#26a69a"/>
    <line x1="630" y1="380" x2="630" y2="640" stroke="#ef5350" stroke-width="16"/>
    <rect x="585" y="420" width="90" height="140" rx="14" fill="#ef5350"/>
    <line x1="800" y1="230" x2="800" y2="560" stroke="#26a69a" stroke-width="16"/>
    <rect x="755" y="280" width="90" height="220" rx="14" fill="#26a69a"/>
  </g>
  <polyline points="180,800 380,640 560,700 760,460 880,380" fill="none" stroke="url(#glow)" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'icon.svg'), svg);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.screenshot({ path: join(out, 'icon.png'), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await browser.close();

// macOS icon set: each size at 1× and 2×.
const set = join(tmpdir(), `ts-icon-${process.pid}.iconset`);
rmSync(set, { recursive: true, force: true });
mkdirSync(set);
for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
        const px = size * scale;
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        execFileSync('sips', ['-z', String(px), String(px), join(out, 'icon.png'), '--out', join(set, name)], { stdio: 'ignore' });
    }
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(out, 'icon.icns')]);
rmSync(set, { recursive: true, force: true });
console.log(`icon written to ${out}`);
