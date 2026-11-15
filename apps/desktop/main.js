// Trade Station desktop shell. Starts the trading server on Electron's own Node, on a free local
// port, with its data in the app's user-data folder; opens the built web app in a window; and stops
// the server (letting it save the paper account and pause strategies) when the app quits.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';

// Installed, the bundled server and the built web app sit in the app's resources; run from the
// project folder, they are the sources and the latest build.
const packaged = app.isPackaged;
const root = packaged ? process.resourcesPath : join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverEntry = packaged ? join(root, 'server', 'main.mjs') : join(root, 'apps', 'server', 'src', 'main.ts');
const webDir = packaged ? join(root, 'web') : join(root, 'apps', 'web', 'dist');

/** @type {import('node:child_process').ChildProcess | null} */
let server = null;
let quitting = false;

/** A free port on the loopback interface. */
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = /** @type {import('node:net').AddressInfo} */ (probe.address());
            probe.close(() => resolve(port));
        });
    });
}

/** Wait until the server answers its health check, or give up. */
async function ready(port, ms = 60_000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (server?.exitCode !== null && server?.exitCode !== undefined)
            throw new Error(`the server stopped (exit code ${server.exitCode})`);
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/health`);
            if (res.ok) return;
        } catch {}
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('the server did not start within a minute');
}

async function startServer() {
    const port = Number(process.env.TS_PORT) || (await freePort());
    const dataDir = process.env.TS_DATA_DIR || join(app.getPath('userData'), 'data');
    mkdirSync(dataDir, { recursive: true });
    // Electron's own Node runs the server: a desktop app cannot count on `node` being installed.
    server = spawn(process.execPath, [serverEntry], {
        cwd: root,
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            TS_HOST: '127.0.0.1',
            TS_PORT: String(port),
            TS_DATA_DIR: dataDir,
            TS_WEB_DIR: webDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = (chunk) => {
        for (const line of String(chunk).split('\n'))
            if (line.trim()) console.log(`[server] ${line.replace(/^\[server\] /, '')}`);
    };
    server.stdout?.on('data', log);
    server.stderr?.on('data', log);
    server.on('exit', (code) => {
        if (!quitting) {
            dialog.showErrorBox(
                'Trade Station',
                `The trading server stopped unexpectedly (exit code ${code}). The app will close.`,
            );
            app.quit();
        }
    });
    await ready(port);
    return port;
}

function createWindow(port) {
    const win = new BrowserWindow({
        width: 1600,
        height: 1000,
        minWidth: 900,
        minHeight: 600,
        title: 'Trade Station',
        backgroundColor: '#0e1116',
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    // Links to other sites open in the person's browser, never inside the app.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) void shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
        if (!url.startsWith(`http://127.0.0.1:${port}/`)) {
            event.preventDefault();
            if (/^https?:/i.test(url)) void shell.openExternal(url);
        }
    });
    win.once('ready-to-show', () => win.show());
    void win.loadURL(`http://127.0.0.1:${port}/`);
    return win;
}

/** Stop the server gracefully (it saves its state on SIGTERM), forcing it after five seconds. */
function stopServer() {
    return new Promise((resolve) => {
        if (!server || server.exitCode !== null) return resolve();
        const force = setTimeout(() => server?.kill('SIGKILL'), 5000);
        server.once('exit', () => {
            clearTimeout(force);
            resolve();
        });
        server.kill('SIGTERM');
    });
}

app.setName('Trade Station');
// A second copy would start a second server on the same data: focus the first instead.
if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });

    app.whenReady().then(async () => {
        if (!existsSync(join(webDir, 'index.html'))) {
            dialog.showErrorBox(
                'Trade Station',
                'The app has not been built yet. Run `npm run build` in the project folder, then start the desktop app again.',
            );
            app.quit();
            return;
        }
        Menu.setApplicationMenu(
            Menu.buildFromTemplate([
                ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
                { role: 'editMenu' },
                {
                    label: 'View',
                    submenu: [
                        { role: 'reload' },
                        { role: 'toggleDevTools' },
                        { type: 'separator' },
                        { role: 'resetZoom' },
                        { role: 'zoomIn' },
                        { role: 'zoomOut' },
                        { type: 'separator' },
                        { role: 'togglefullscreen' },
                    ],
                },
                { role: 'windowMenu' },
            ]),
        );
        try {
            const port = await startServer();
            createWindow(port);
            app.on('activate', () => {
                if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
            });
        } catch (err) {
            dialog.showErrorBox('Trade Station', `The trading server could not start: ${err?.message ?? err}`);
            quitting = true;
            await stopServer();
            app.quit();
        }
    });

    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', (event) => {
        if (quitting) return;
        quitting = true;
        event.preventDefault();
        void stopServer().then(() => app.quit());
    });
}
