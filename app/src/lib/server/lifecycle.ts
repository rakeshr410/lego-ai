// Process lifecycle shared between the server bundle and the entry that starts it
// (scripts/serve.ts). They are separate module graphs, so the state lives on a global under a
// registered symbol that both look up: the entry flips `draining` on SIGTERM, /api/ready reports
// it, and modules that hold connections register hooks the entry runs just before exiting.

export type ShutdownHook = () => unknown;

export type Lifecycle = {
  /** SIGTERM received: this instance is going away and must leave the load balancer's rotation. */
  draining: boolean;
  /** Epoch ms the drain started, or null. */
  drainingSince: number | null;
  /** Run once the HTTP server has closed (flush error reports, close Redis). */
  hooks: Set<ShutdownHook>;
};

export const LIFECYCLE_KEY = Symbol.for('arrowbox.lifecycle');

export function lifecycle(): Lifecycle {
  const g = globalThis as { [LIFECYCLE_KEY]?: Lifecycle };
  g[LIFECYCLE_KEY] ??= { draining: false, drainingSince: null, hooks: new Set() };
  return g[LIFECYCLE_KEY];
}

export const isDraining = () => lifecycle().draining;

/** Registers work to do before the process exits; returns a function that unregisters it. */
export function onShutdown(hook: ShutdownHook): () => void {
  const { hooks } = lifecycle();
  hooks.add(hook);
  return () => hooks.delete(hook);
}
