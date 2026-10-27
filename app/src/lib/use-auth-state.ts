import { useEffect, useState } from 'react';
import { on } from '../../../../lego/events/src/bus.ts';
import { authState, type AuthState } from './auth-state';

/**
 * The page's signed-in state (lib/auth-state.ts) for the modules' React: null on the first render,
 * then the shell's answer, following `auth.changed` on the page's bus.
 */
export function useAuthState(): AuthState | null {
  const [state, setState] = useState<AuthState | null>(null);
  useEffect(() => {
    const read = () => setState(authState());
    read();
    return on('auth.changed', read);
  }, []);
  return state;
}
