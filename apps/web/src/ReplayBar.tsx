import { lowerTimeframeTicks } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { useCallback, useEffect, useState } from 'react';
import { useUi } from './lib/store.ts';
import { Button } from './ui.tsx';

const SPEEDS = [0.5, 1, 2, 5, 10, 20];

interface ReplayState {
    active: boolean;
    playing: boolean;
    cursorTime: number | null;
    remaining: number;
}

const stamp = (t: number | null) =>
    t === null ? '—' : `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Bar replay controls for the whole workspace: every chart rewinds and plays on one clock. */
export function ReplayBar({ workspace }: { workspace: VelaWorkspace }) {
    const replay: any = (workspace as any).replay;
    const [state, setState] = useState<ReplayState>(() => ({ ...replay.state }));
    const [speed, setSpeed] = useState(1);
    const [picking, setPicking] = useState(false);
    const [ticks, setTicks] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const close = useUi((s) => s.setReplayOpen);

    useEffect(() => {
        const read = () => setState({ ...replay.state });
        const offs = ['replay:start', 'replay:step', 'replay:play', 'replay:pause', 'replay:end'].map((ev) =>
            replay.on(ev, read),
        );
        read();
        return () => {
            for (const off of offs) off();
        };
    }, [replay]);

    const start = useCallback(
        async (from: number) => {
            setError(null);
            try {
                await replay.start({ from });
                setState({ ...replay.state });
            } catch (err: any) {
                setError(err?.message ?? 'could not start the replay');
            }
        },
        [replay],
    );

    /** Let the user click the bar to start from: the bars after the cursor are dimmed while picking. */
    const pick = useCallback(() => {
        const chart: any = workspace.chart;
        setPicking(true);
        chart.renderer.set({
            crosshairOverride: { horizontal: false, shadeRight: { color: 'rgba(0, 0, 0, 0.45)' } },
            drawingsInteractive: false,
        });
        const restore = () => {
            chart.renderer.set({ crosshairOverride: null, drawingsInteractive: true });
            setPicking(false);
        };
        const off = chart.renderer.onClick(({ time }: { time: number | null }) => {
            if (time === null) return;
            off();
            document.removeEventListener('keydown', onKey, true);
            restore();
            void start(time);
        });
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            off();
            document.removeEventListener('keydown', onKey, true);
            restore();
        };
        document.addEventListener('keydown', onKey, true);
    }, [workspace, start]);

    const startBack = (bars: number) => {
        const chart: any = workspace.chart;
        const bounds = chart.replay.bounds as { first: number; last: number } | null;
        const range = chart.getVisibleRange?.() as { from: number; to: number } | null;
        if (!bounds) return;
        // Step back from the newest bar by the visible bar spacing.
        const tfMs = range ? Math.max(1, (range.to - range.from) / 200) : 60_000;
        void start(Math.max(bounds.first, bounds.last - bars * estimateBarMs(chart, tfMs)));
    };

    const stop = () => {
        replay.stop();
        const chart: any = workspace.chart;
        chart.replay?.setTicks?.(null);
        setTicks(false);
    };

    const single = (workspace.cells() as unknown[]).length === 1;

    return (
        <div className="replay-bar" data-testid="replay-bar">
            <span className="badge">REPLAY</span>
            {!state.active ? (
                <>
                    <Button variant="primary" onClick={pick} disabled={picking}>
                        {picking ? 'Click a bar on the chart… (Esc to cancel)' : 'Pick start bar'}
                    </Button>
                    <Button onClick={() => startBack(100)}>100 bars back</Button>
                    <Button onClick={() => startBack(500)}>500 bars back</Button>
                    <Button onClick={() => void start(0)}>From first bar</Button>
                </>
            ) : (
                <>
                    {state.playing ? (
                        <Button variant="primary" onClick={() => replay.pause()}>
                            ❚❚ Pause
                        </Button>
                    ) : (
                        <Button
                            variant="primary"
                            onClick={() => replay.play(1000 / speed)}
                            disabled={state.remaining === 0}
                        >
                            ▶ Play
                        </Button>
                    )}
                    <Button onClick={() => replay.step()} disabled={state.remaining === 0} title="Reveal the next bar">
                        Step ▶|
                    </Button>
                    <select
                        className="text"
                        aria-label="Replay speed"
                        value={speed}
                        onChange={(e) => {
                            const next = Number(e.target.value);
                            setSpeed(next);
                            if (replay.state.playing) replay.play(1000 / next);
                        }}
                    >
                        {SPEEDS.map((s) => (
                            <option key={s} value={s}>
                                {s}× ({Math.round(1000 / s)} ms/bar)
                            </option>
                        ))}
                    </select>
                    {single && (
                        <label
                            className="row"
                            title="Build each bar from its 1-minute bars instead of revealing it whole"
                        >
                            <input
                                type="checkbox"
                                checked={ticks}
                                onChange={(e) => {
                                    const chart: any = workspace.chart;
                                    setTicks(e.target.checked);
                                    chart.replay.setTicks(e.target.checked ? lowerTimeframeTicks(chart, '1') : null);
                                }}
                            />
                            Intrabar
                        </label>
                    )}
                    <Button onClick={pick} disabled={picking}>
                        {picking ? 'Click a bar…' : 'Jump to…'}
                    </Button>
                    <span className="muted">
                        at {stamp(state.cursorTime)} · {state.remaining} bars left
                    </span>
                    <Button variant="danger" onClick={stop}>
                        Stop
                    </Button>
                </>
            )}
            {error && <span className="error">{error}</span>}
            <span className="spacer" />
            <button
                type="button"
                className="icon-btn"
                title="Close replay"
                onClick={() => {
                    if (replay.state.active) stop();
                    close(false);
                }}
            >
                ×
            </button>
        </div>
    );
}

/** Bar duration from the chart's own timeframe, falling back to an estimate. */
function estimateBarMs(chart: any, fallback: number): number {
    const tf = String(chart.market?.timeframe ?? '');
    const m = /^(\d+)([SDWM]?)$/i.exec(tf);
    if (!m) return fallback;
    const n = Number(m[1]);
    const unit = m[2].toUpperCase();
    return unit === 'S'
        ? n * 1000
        : unit === 'D'
          ? n * 86_400_000
          : unit === 'W'
            ? n * 604_800_000
            : unit === 'M'
              ? n * 2_592_000_000
              : n * 60_000;
}
