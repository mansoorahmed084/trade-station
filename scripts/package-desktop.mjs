// Build the macOS desktop installer: the web app, the bundled server, then the .app and its DMG.
//
// Signing: with a "Developer ID Application" certificate in the keychain (or CSC_LINK / CSC_NAME
// set), the app is signed with it; with APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID set
// as well, it is also notarized. Without a certificate it is signed ad hoc: it runs on this Mac,
// and other Macs warn before opening it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const windows = process.platform === 'win32';
// On Windows, npm is a .cmd script: it runs only through a shell.
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: windows, ...opts });

run('npm', ['run', 'build']);
run('node', ['scripts/bundle-server.mjs']);

if (windows) {
    // Windows: an NSIS installer (unsigned unless CSC_LINK / CSC_KEY_PASSWORD point to a code-signing
    // certificate; unsigned, SmartScreen warns before it runs).
    const { build, Platform } = await import('electron-builder');
    const config = JSON.parse(readFileSync(join(desktop, 'packaging.json'), 'utf8'));
    const artifacts = await build({ projectDir: desktop, targets: Platform.WINDOWS.createTarget(), config, publish: 'never' });
    console.log(`\nbuilt:\n${artifacts.map((a) => `  ${a}`).join('\n')}`);
    const setup = artifacts.find((a) => a.endsWith('.exe'));
    if (setup) console.log(`\ninstaller: ${setup}`);
    process.exit(0);
}

const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
const certificate = !!(process.env.CSC_LINK || process.env.CSC_NAME) || /Developer ID Application/.test(identities);
const notarize = certificate && !!(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

const { build, Platform } = await import(join(desktop, 'node_modules', 'electron-builder', 'out', 'index.js')).catch(() => import('electron-builder'));
const config = JSON.parse(readFileSync(join(desktop, 'packaging.json'), 'utf8'));
config.mac.notarize = notarize;
// codesign does not run from the project folder: give it absolute paths.
for (const key of ['entitlements', 'entitlementsInherit', 'icon']) config.mac[key] = join(desktop, config.mac[key]);
if (!certificate) {
    // Ad hoc: a signature that makes the app runnable here, without an identity behind it. It can
    // carry neither a timestamp nor the hardened runtime's entitlements.
    config.mac.identity = '-';
    config.mac.hardenedRuntime = false;
    config.mac.timestamp = 'none';
    delete config.mac.entitlements;
    delete config.mac.entitlementsInherit;
}
console.log(certificate ? `signing with your certificate${notarize ? ' and notarizing' : ' (not notarizing: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID)'}` : 'no Developer ID certificate found: signing ad hoc');

const artifacts = await build({ projectDir: desktop, targets: Platform.MAC.createTarget(), config, publish: 'never' });
const dmg = artifacts.find((a) => a.endsWith('.dmg'));
console.log(`\nbuilt:\n${artifacts.map((a) => `  ${a}`).join('\n')}`);
const app = join(desktop, 'dist', 'mac-arm64', `${config.productName}.app`);
try {
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=1', app]);
} catch {
    console.log('codesign could not verify the app');
}
if (dmg) console.log(`\ninstaller: ${dmg}`);
