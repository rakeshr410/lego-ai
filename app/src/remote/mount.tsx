import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { emit } from '../../../../lego/events/src/bus.ts';
import { isLive, leaveLive } from '../lib/live-session';
import type { Mounted } from './contract';

/** Renders `node` into the shell's element (contract.ts Mounted). A render that throws is logged and said on the bus. */
export function mountReact(element: HTMLElement, node: ReactNode, module: 'interview' | 'classroom'): Mounted {
  const root = createRoot(element, {
    onUncaughtError: (error) => {
      console.error(`[${module}] the module failed to render`, error);
      emit('remote.failed', { module, error: error instanceof Error ? error.message : String(error) }, module);
    },
  });
  root.render(node);
  return { unmount: () => root.unmount(), live: isLive, leave: leaveLive };
}
