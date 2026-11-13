/**
 * Soak: subscribe to live bars through the server, then compare every bar that closed during the
 * run against the venue's own history, fetched directly and independently of our server.
 * Any missing, duplicate or different bar is a failure.
 * Run: node tests/soak/live-soak.ts [minutes]   (needs the server on :8787)
 */
import { type Bar, barOpenTime } from '@ts/core';
import { decodeBarFrame } from '@ts/protocol';
import { WebSocket } from 'ws';

const minutes = Number(process.argv[2] ?? 15);
const SERVER = process.env.TS_SERVER ?? 'http://127.0.0.1:8787';
const SERIES: { symbol: string; ticker: string; tf: string; interval: string }[] = [
    { symbol: 'BINANCE:BTCUSDT', ticker: 'BTCUSDT', tf: '1', interval: '1m' },
    { symbol: 'BINANCE:ETHUSDT', ticker: 'ETHUSDT', tf: '1', interval: '1m' },
    { symbol: 'BINANCE:BTCUSDT', ticker: 'BTCUSDT', tf: '5', interval: '5m' },
    { symbol: 'BINANCE:BTCUSDT', ticker: 'BTCUSDT', tf: '3', interval: '3m' },
];

const closed: Bar[][] = SERIES.map(() => []);
const last: (Bar | null)[] = SERIES.map(() => null);
let frames = 0;
let outOfOrder = 0;

const ws = new WebSocket(`${SERVER.replace('http', 'ws')}/ws`);
await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
});
ws.on('message', (raw: Buffer, isBinary: boolean) => {
    if (!isBinary) return;
    const f = decodeBarFrame(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
    const i = f.subId - 1;
    frames++;
    const prev = last[i];
    if (prev && f.bar.time < prev.time) outOfOrder++;
    if (prev && f.bar.time > prev.time) closed[i].push(prev);
    last[i] = f.bar;
});
for (const [i, s] of SERIES.entries()) ws.send(JSON.stringify({ op: 'sub', id: i + 1, symbol: s.symbol, tf: s.tf }));

console.log(`soaking ${SERIES.length} live series for ${minutes} min…`);
await new Promise((r) => setTimeout(r, minutes * 60_000));
ws.close();

let bad = 0;
for (let i = 0; i < SERIES.length; i++) {
    const s = SERIES[i];
    const live = closed[i];
    if (live.length === 0) {
        console.log(`${s.symbol} ${s.tf}: no bar closed during the run`);
        continue;
    }
    const from = live[0].time;
    const to = live[live.length - 1].time;
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${s.ticker}&interval=${s.interval}&startTime=${from}&endTime=${to}&limit=1000`;
    const truth: Bar[] = ((await (await fetch(url)).json()) as any[][]).map((r) => ({
        time: r[0],
        open: +r[1],
        high: +r[2],
        low: +r[3],
        close: +r[4],
        volume: +r[5],
    }));
    const liveTimes = live.map((b) => b.time);
    const dupes = liveTimes.length - new Set(liveTimes).size;
    const missing = truth.filter((t) => !liveTimes.includes(t.time)).length;
    const extra = live.filter((b) => !truth.some((t) => t.time === b.time)).length;
    let different = 0;
    const examples: string[] = [];
    // The first bar of an aggregated series may have been joined mid-bucket by the venue's stream.
    for (const b of live.slice(barOpenTime(from, s.tf) === from ? 0 : 1)) {
        const t = truth.find((x) => x.time === b.time);
        if (!t) continue;
        const same =
            t.open === b.open &&
            t.high === b.high &&
            t.low === b.low &&
            t.close === b.close &&
            Math.abs(t.volume - b.volume) < 1e-6;
        if (!same) {
            different++;
            if (examples.length < 3)
                examples.push(
                    `  ${new Date(b.time).toISOString()} live ${JSON.stringify(b)} venue ${JSON.stringify(t)}`,
                );
        }
    }
    const ok = dupes === 0 && missing === 0 && extra === 0 && different === 0;
    if (!ok) bad++;
    console.log(
        `${s.symbol} ${s.tf}: ${live.length} closed bars — missing ${missing}, duplicate ${dupes}, unexpected ${extra}, different ${different} ${ok ? 'OK' : 'FAIL'}`,
    );
    for (const e of examples) console.log(e);
}
console.log(`frames received: ${frames}, out-of-order frames: ${outOfOrder}`);
if (bad || outOfOrder) process.exitCode = 1;
