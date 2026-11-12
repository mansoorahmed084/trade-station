// Starts the API server and the web dev server together; stops both on exit.
import { spawn } from 'node:child_process';

const procs = [
    spawn('npm', ['run', 'dev:server'], { stdio: 'inherit' }),
    spawn('npm', ['run', 'dev:web'], { stdio: 'inherit' }),
];
const stop = () => {
    for (const p of procs) p.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
