import { create } from 'zustand';

export type RightPanel = 'watchlist';
export type BottomPanel = 'editor';
export type DialogId = 'layouts' | 'formula' | 'chartType';

interface UiState {
    rightPanel: RightPanel | null;
    bottomPanel: BottomPanel | null;
    bottomHeight: number;
    replayOpen: boolean;
    dialog: DialogId | null;
    toggleRightPanel(panel: RightPanel): void;
    toggleBottomPanel(panel: BottomPanel): void;
    setBottomHeight(height: number): void;
    setReplayOpen(open: boolean): void;
    setDialog(dialog: DialogId | null): void;
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
    toggleRightPanel(panel) {
        set({ rightPanel: get().rightPanel === panel ? null : panel });
        persist(get());
    },
    toggleBottomPanel(panel) {
        set({ bottomPanel: get().bottomPanel === panel ? null : panel });
        persist(get());
    },
    setBottomHeight(height) {
        set({ bottomHeight: Math.min(700, Math.max(160, Math.round(height))) });
        persist(get());
    },
    setReplayOpen: (replayOpen) => set({ replayOpen }),
    setDialog: (dialog) => set({ dialog }),
}));
