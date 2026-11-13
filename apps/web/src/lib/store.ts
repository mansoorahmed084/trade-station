import { create } from 'zustand';

export type RightPanel = 'watchlist';
export type DialogId = 'layouts' | 'formula' | 'chartType';

interface UiState {
    rightPanel: RightPanel | null;
    replayOpen: boolean;
    dialog: DialogId | null;
    toggleRightPanel(panel: RightPanel): void;
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

/** Which of our own panels and dialogs are open. Chart state lives in the workspace, not here. */
export const useUi = create<UiState>((set, get) => ({
    rightPanel: saved.rightPanel === null ? null : (saved.rightPanel ?? 'watchlist'),
    replayOpen: false,
    dialog: null,
    toggleRightPanel(panel) {
        set({ rightPanel: get().rightPanel === panel ? null : panel });
        try {
            localStorage.setItem('ts.ui', JSON.stringify({ rightPanel: get().rightPanel }));
        } catch {}
    },
    setReplayOpen: (replayOpen) => set({ replayOpen }),
    setDialog: (dialog) => set({ dialog }),
}));
