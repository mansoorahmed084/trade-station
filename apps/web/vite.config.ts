import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER = process.env.TS_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
    plugins: [react()],
    server: {
        host: '127.0.0.1',
        proxy: {
            '/api': { target: SERVER, changeOrigin: false },
            '/ws': { target: SERVER, ws: true, changeOrigin: false },
        },
    },
    build: {
        target: 'es2023',
        sourcemap: true,
        chunkSizeWarningLimit: 6000,
        rollupOptions: { input: { main: 'index.html', bench: 'bench.html' } },
    },
    worker: { format: 'es' },
});
