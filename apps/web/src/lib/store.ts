import type { AlertInput } from '@ts/alerts/types';
import { create } from 'zustand';

export type RightPanel = 'watchlist' | 'alerts' | 'trade' | 'dom';
export type BottomPanel = 'editor' | 'tester' | 'trading';
export type DialogId = 'layouts' | 'formula' | 'chartType' | 'alert';

/** What the alert dialog opens with: an existing alert to edit, or values to start a new one from. */
export interface AlertDraft {
    editId?: string;
    preset?: AlertInput;
}

interface UiState {
    rightPanel: RightPanel | null;
    bottomPanel: BottomPanel | null;
    bottomHeight: number;
    replayOpen: boolean;
    dialog: DialogId | null;
    alertDraft: AlertDraft | null;
    toggleRightPanel(panel: RightPanel): void;
    showRightPanel(panel: RightPanel | null): void;
    toggleBottomPanel(panel: BottomPanel): void;
    showBottomPanel(panel: BottomPanel): void;
    setBottomHeight(height: number): void;
    setReplayOpen(open: boolean): void;
    setDialog(dialog: DialogId | null): void;
    openAlertDialog(draft: AlertDraft): void;
}

const saved = (() => {
    try {
        return JSON.parse(localStorage.getItem('ts.ui') ?? '{}') as Partial<UiState>;
    } catch {
        return {};
    }
})();

const persist = (s: UiState) => {
    try {
        localStorage.setItem(
            'ts.ui',
            JSON.stringify({ rightPanel: s.rightPanel, bottomPanel: s.bottomPanel, bottomHeight: s.bottomHeight }),
        );
    } catch {}
};

/** Which of our own panels and dialogs are open. Chart state lives in the workspace, not here. */
export const useUi = create<UiState>((set, get) => ({
    rightPanel: saved.rightPanel === null ? null : (saved.rightPanel ?? 'watchlist'),
    bottomPanel: saved.bottomPanel ?? null,
    bottomHeight: Math.min(700, Math.max(160, saved.bottomHeight ?? 340)),
    replayOpen: false,
    dialog: null,
    alertDraft: null,
    toggleRightPanel(panel) {
        set({ rightPanel: get().rightPanel === panel ? null : panel });
        persist(get());
    },
    showRightPanel(panel) {
        set({ rightPanel: panel });
        persist(get());
    },
    toggleBottomPanel(panel) {
        set({ bottomPanel: get().bottomPanel === panel ? null : panel });
        persist(get());
    },
    showBottomPanel(panel) {
        set({ bottomPanel: panel });
        persist(get());
    },
    setBottomHeight(height) {
        set({ bottomHeight: Math.min(700, Math.max(160, Math.round(height))) });
        persist(get());
    },
    setReplayOpen: (replayOpen) => set({ replayOpen }),
    setDialog: (dialog) => set({ dialog, ...(dialog === 'alert' ? {} : { alertDraft: null }) }),
    openAlertDialog: (alertDraft) => set({ dialog: 'alert', alertDraft }),
}));
