import { registerIcon, registerWidgetAction, registerWidgetAttachment } from '@luxalgo/vela/plugin';
import { registerChartLines } from './chart-lines.ts';
import { isDerived, registerChartTypes } from './chart-types.ts';
import { exportActiveChart } from './export.ts';
import { useUi } from './store.ts';

const icon = (paths: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

let done = false;

/** Register our chart types and toolbar buttons with the chart engine. Must run before a workspace is built. */
export function setupVela(): void {
    if (done) return;
    done = true;
    registerChartTypes();
    registerChartLines();

    // Our alerts run on the server and have their own panel: retire the chart's built-in bell,
    // which only knows about scripts running in this browser.
    registerWidgetAttachment({
        id: 'ts.alerts.bell',
        mount: (ctx: any) => {
            ctx.topbar?.setVisible?.('alerts', false);
            return () => ctx.topbar?.setVisible?.('alerts', true);
        },
    });
    registerIcon(
        'ts-bell',
        icon('<path d="M4 11V7.5a4 4 0 0 1 8 0V11l1.2 1.5H2.8z"/><path d="M6.6 13.6a1.5 1.5 0 0 0 2.8 0"/>'),
    );
    registerWidgetAction({
        id: 'ts.alerts',
        target: 'topbar',
        label: 'Alerts',
        icon: 'ts-bell',
        iconOnly: true,
        order: 35,
        run: () => useUi.getState().toggleRightPanel('alerts'),
    });
    registerWidgetAction({
        id: 'ts.alert.here',
        target: 'context:body',
        label: 'Add alert at this price',
        order: 40,
        when: (ctx: any) => ctx.pointer?.paneKind === 'price' && Number.isFinite(ctx.pointer?.price),
        run: (ctx: any) => {
            const price = Number(ctx.pointer.price);
            // Round to the precision the axis shows, not to float noise.
            const digits = price >= 1000 ? 2 : price >= 1 ? 4 : 8;
            useUi.getState().openAlertDialog({
                preset: {
                    condition: {
                        left: { type: 'price' },
                        op: 'crossing',
                        right: { type: 'value', value: Number(price.toFixed(digits)) },
                    },
                },
            });
        },
    });

    registerIcon(
        'ts-replay',
        icon('<path d="M3 8a5 5 0 1 0 1.6-3.7"/><path d="M3 2.5v3h3"/><path d="M7 6l3 2-3 2z"/>'),
    );
    registerIcon('ts-formula', icon('<path d="M2 12l3.5-5 2.5 3 2-2.5L14 11"/><path d="M2 5.5l3 1.5 3-3 3 2 3-2.5"/>'));
    registerIcon(
        'ts-layouts',
        icon('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 6.5h12M7 6.5v7"/>'),
    );
    registerIcon('ts-export', icon('<path d="M8 2.5v8"/><path d="M5 7.5l3 3 3-3"/><path d="M2.5 12.5h11"/>'));
    registerIcon('ts-watchlist', icon('<path d="M2.5 4h11M2.5 8h11M2.5 12h7"/>'));
    registerIcon(
        'ts-charttype',
        icon(
            '<rect x="2" y="8" width="3" height="3"/><rect x="5" y="5" width="3" height="3"/><rect x="8" y="8" width="3" height="3"/><rect x="11" y="5" width="3" height="3"/>',
        ),
    );

    registerIcon(
        'ts-editor',
        icon('<path d="M5.5 4.5L2 8l3.5 3.5"/><path d="M10.5 4.5L14 8l-3.5 3.5"/><path d="M9 3l-2 10"/>'),
    );
    registerWidgetAction({
        id: 'ts.editor',
        target: 'topbar',
        label: 'Pine editor and script library',
        icon: 'ts-editor',
        iconOnly: true,
        order: 0,
        run: () => useUi.getState().toggleBottomPanel('editor'),
    });
    registerIcon('ts-tester', icon('<path d="M2.5 13.5h11"/><path d="M4 11V7.5M8 11V3.5M12 11V6"/>'));
    registerWidgetAction({
        id: 'ts.tester',
        target: 'topbar',
        label: 'Strategy tester',
        icon: 'ts-tester',
        iconOnly: true,
        order: 0.5,
        run: () => useUi.getState().toggleBottomPanel('tester'),
    });
    registerWidgetAction({
        id: 'ts.replay',
        target: 'topbar',
        label: 'Bar replay',
        icon: 'ts-replay',
        iconOnly: true,
        order: 1,
        run: () => useUi.getState().setReplayOpen(!useUi.getState().replayOpen),
    });
    registerWidgetAction({
        id: 'ts.formula',
        target: 'topbar',
        label: 'Compare or spread',
        icon: 'ts-formula',
        iconOnly: true,
        order: 2,
        run: () => useUi.getState().setDialog('formula'),
    });
    registerWidgetAction({
        id: 'ts.chartType',
        target: 'topbar',
        label: 'Chart type settings',
        icon: 'ts-charttype',
        iconOnly: true,
        order: 3,
        when: (ctx: any) => isDerived(ctx.priceStyle),
        run: () => useUi.getState().setDialog('chartType'),
    });
    registerWidgetAction({
        id: 'ts.layouts',
        target: 'topbar',
        label: 'Saved layouts and templates',
        icon: 'ts-layouts',
        iconOnly: true,
        order: 10,
        run: () => useUi.getState().setDialog('layouts'),
    });
    registerWidgetAction({
        id: 'ts.export',
        target: 'topbar',
        label: 'Export chart data (CSV)',
        icon: 'ts-export',
        iconOnly: true,
        order: 20,
        run: (ctx: any) =>
            void exportActiveChart(ctx.chart).catch((err) => ctx.toast?.(`Export failed: ${err.message}`, 'error')),
    });
    registerWidgetAction({
        id: 'ts.watchlist',
        target: 'topbar',
        label: 'Watchlist',
        icon: 'ts-watchlist',
        iconOnly: true,
        order: 30,
        run: () => useUi.getState().toggleRightPanel('watchlist'),
    });
    for (const target of ['context:body'] as const) {
        registerWidgetAction({
            id: 'ts.export.menu',
            target,
            label: 'Export chart data (CSV)',
            order: 50,
            run: (ctx: any) => void exportActiveChart(ctx.chart).catch(() => {}),
        });
    }
}
