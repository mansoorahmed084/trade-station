import type { Alert, AlertEvent, AlertInput } from '@ts/alerts/types';
import { create } from 'zustand';
import type { ServerClient } from './client.ts';

export interface Toast {
    id: string;
    title: string;
    text: string;
    kind: 'alert' | 'info' | 'error';
}

interface AlertsState {
    alerts: Alert[];
    log: AlertEvent[];
    channels: { telegram: boolean; email: boolean };
    toasts: Toast[];
    /** Unseen fires since the alerts panel was last looked at. */
    unseen: number;
    loaded: boolean;
    start(client: ServerClient): () => void;
    reload(client: ServerClient): Promise<void>;
    save(client: ServerClient, input: AlertInput, id?: string): Promise<Alert>;
    setActive(client: ServerClient, id: string, active: boolean): Promise<void>;
    remove(client: ServerClient, id: string): Promise<void>;
    clearLog(client: ServerClient): Promise<void>;
    toast(toast: Omit<Toast, 'id'>, ms?: number): void;
    dismiss(id: string): void;
    markSeen(): void;
}

let audio: AudioContext | null = null;

/** A short two-tone chime, synthesised so there is no sound file to ship. */
export function chime(): void {
    try {
        audio ??= new AudioContext();
        const ctx = audio;
        const now = ctx.currentTime;
        for (const [i, freq] of [880, 1320].entries()) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, now + i * 0.14);
            gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.14 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.3);
            osc.connect(gain).connect(ctx.destination);
            osc.start(now + i * 0.14);
            osc.stop(now + i * 0.14 + 0.32);
        }
    } catch {}
}

let toastSeq = 0;

export const useAlerts = create<AlertsState>((set, get) => ({
    alerts: [],
    log: [],
    channels: { telegram: false, email: false },
    toasts: [],
    unseen: 0,
    loaded: false,

    start(client) {
        void get().reload(client);
        client
            .json<{ telegram: boolean; email: boolean }>('/api/alerts/channels')
            .then((channels) => set({ channels }))
            .catch(() => {});
        let timer: ReturnType<typeof setTimeout> | null = null;
        const off = client.listen<any>('alerts', (msg) => {
            if (msg.type === 'fired') {
                const event = msg.event as AlertEvent;
                if (!msg.test) set((s) => ({ log: [event, ...s.log].slice(0, 500), unseen: s.unseen + 1 }));
                if (msg.app) {
                    get().toast(
                        {
                            title: `${event.late ? 'Missed alert' : 'Alert'}: ${event.alertName}`,
                            text: event.message,
                            kind: 'alert',
                        },
                        10_000,
                    );
                    if (event.sound) chime();
                    if (
                        typeof Notification !== 'undefined' &&
                        Notification.permission === 'granted' &&
                        document.visibilityState !== 'visible'
                    ) {
                        try {
                            new Notification(event.alertName, { body: event.message, tag: event.id });
                        } catch {}
                    }
                }
            }
            // Coalesce bursts of changes into one reload.
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => void get().reload(client), 150);
        });
        // After a reconnect the list may have moved on without us.
        const offStatus = client.events.on('status', (status) => {
            if (status === 'open') void get().reload(client);
        });
        return () => {
            off();
            offStatus();
            if (timer) clearTimeout(timer);
        };
    },

    async reload(client) {
        const [alerts, log] = await Promise.all([
            client.json<Alert[]>('/api/alerts'),
            client.json<AlertEvent[]>('/api/alerts/log?limit=300'),
        ]);
        set({ alerts, log, loaded: true });
    },

    async save(client, input, id) {
        const alert = id
            ? await client.post<Alert>(`/api/alerts/${id}`, input, 'PUT')
            : await client.post<Alert>('/api/alerts', input);
        await get().reload(client);
        return alert;
    },

    async setActive(client, id, active) {
        await client.post(`/api/alerts/${id}/active`, { active });
        await get().reload(client);
    },

    async remove(client, id) {
        await client.json(`/api/alerts/${id}`, { method: 'DELETE' });
        await get().reload(client);
    },

    async clearLog(client) {
        await client.json('/api/alerts/log', { method: 'DELETE' });
        set({ log: [], unseen: 0 });
    },

    toast(toast, ms = 6000) {
        const id = `t${++toastSeq}`;
        // At most three at a time, so they never bury the panels under them.
        set((s) => ({ toasts: [...s.toasts, { ...toast, id }].slice(-3) }));
        setTimeout(() => get().dismiss(id), ms);
    },

    dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    markSeen: () => set({ unseen: 0 }),
}));
