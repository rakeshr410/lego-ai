import { useEffect, useState } from 'react';
import { AUTH_EVENT, authState, type AuthState } from './auth-state';

/**
 * The page's signed-in state (lib/auth-state.ts) for React islands: null while hydrating (the
 * server-rendered markup, whose links point at the topics), then the head script's answer,
 * following markSignedOut().
 */
export function useAuthState(): AuthState | null {
  const [state, setState] = useState<AuthState | null>(null);
  useEffect(() => {
    const read = () => setState(authState());
    read();
    document.addEventListener(AUTH_EVENT, read);
    return () => document.removeEventListener(AUTH_EVENT, read);
  }, []);
  return state;
}
