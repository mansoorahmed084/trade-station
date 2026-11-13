import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { createContext, useContext } from 'react';
import type { ServerClient } from './lib/client.ts';

export interface AppServices {
    client: ServerClient;
    /** The chart workspace, once mounted. */
    workspace: VelaWorkspace | null;
}

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error('useApp outside AppContext');
    return ctx;
}
