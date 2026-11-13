import type { Bar } from '@ts/core';

/**
 * Wire protocol between the server gateway and the web client, over one WebSocket at `/ws`.
 * Control messages are JSON text frames; live bar updates are fixed 64-byte binary frames.
 */

export type ClientMessage =
    | { op: 'sub'; id: number; symbol: string; tf: string }
    | { op: 'unsub'; id: number }
    | { op: 'ping'; t: number }
    | { op: 'listen'; topics: string[] };

export type ServerMessage =
    | { op: 'hello'; version: number; now: number }
    | { op: 'pong'; t: number; now: number }
    | { op: 'subscribed'; id: number }
    | { op: 'error'; id?: number; message: string }
    | { op: 'event'; topic: string; data: unknown };

export const PROTOCOL_VERSION = 1;
export const FRAME_BAR = 1;
export const BAR_FRAME_BYTES = 64;

/** kind u8 · flags u8 (bit 0 = opened a new bar) · reserved u16 · subscription u32 · 6 × f64 bar · f64 server send time */
export function encodeBarFrame(subId: number, bar: Bar, opened: boolean, sentAt: number): ArrayBuffer {
    const buf = new ArrayBuffer(BAR_FRAME_BYTES);
    const view = new DataView(buf);
    view.setUint8(0, FRAME_BAR);
    view.setUint8(1, opened ? 1 : 0);
    view.setUint32(4, subId, true);
    view.setFloat64(8, bar.time, true);
    view.setFloat64(16, bar.open, true);
    view.setFloat64(24, bar.high, true);
    view.setFloat64(32, bar.low, true);
    view.setFloat64(40, bar.close, true);
    view.setFloat64(48, bar.volume, true);
    view.setFloat64(56, sentAt, true);
    return buf;
}

export interface BarFrame {
    subId: number;
    bar: Bar;
    opened: boolean;
    sentAt: number;
}

export function decodeBarFrame(buf: ArrayBuffer): BarFrame {
    if (buf.byteLength !== BAR_FRAME_BYTES) throw new Error(`bad bar frame length ${buf.byteLength}`);
    const view = new DataView(buf);
    if (view.getUint8(0) !== FRAME_BAR) throw new Error('not a bar frame');
    return {
        subId: view.getUint32(4, true),
        opened: (view.getUint8(1) & 1) === 1,
        bar: {
            time: view.getFloat64(8, true),
            open: view.getFloat64(16, true),
            high: view.getFloat64(24, true),
            low: view.getFloat64(32, true),
            close: view.getFloat64(40, true),
            volume: view.getFloat64(48, true),
        },
        sentAt: view.getFloat64(56, true),
    };
}
