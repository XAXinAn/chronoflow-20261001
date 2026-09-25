import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import type { StoredSession } from '../auth/tokenStore';
import type { AppRuntime } from '../runtime';
import { createTheme, type AppTheme } from '../theme';
import type { ColorScheme } from '@xa-todo/design-tokens';

interface AppContextValue {
  theme: AppTheme;
  scheme: ColorScheme;
  runtime: AppRuntime | null;
  session: StoredSession | null;
  toggleScheme: () => void;
  setRuntime: (runtime: AppRuntime | null) => void;
  setSession: (session: StoredSession | null) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  systemScheme,
  children,
}: {
  systemScheme: ColorScheme;
  children: ReactNode;
}) {
  const [override, setOverride] = useState<ColorScheme | null>(null);
  const [runtime, setRuntime] = useState<AppRuntime | null>(null);
  const [session, setSession] = useState<StoredSession | null>(null);

  const scheme = override ?? systemScheme;
  const theme = useMemo(() => createTheme(scheme), [scheme]);
  const toggleScheme = useCallback(() => {
    setOverride((current) => ((current ?? systemScheme) === 'light' ? 'dark' : 'light'));
  }, [systemScheme]);

  const value = useMemo<AppContextValue>(
    () => ({ theme, scheme, runtime, session, toggleScheme, setRuntime, setSession }),
    [theme, scheme, runtime, session, toggleScheme],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useAppContext(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useAppContext 必须在 AppProvider 内使用');
  }
  return value;
}

export function useAppTheme(): AppTheme {
  return useAppContext().theme;
}

export function useAppScheme(): ColorScheme {
  return useAppContext().scheme;
}

export function useAppSessionState() {
  const { session, setSession, toggleScheme } = useAppContext();
  return { session, setSession, toggleScheme };
}

/** 已登录后才可使用；未就绪时抛错以便尽早暴露装配问题。 */
export function useRuntime(): AppRuntime {
  const { runtime } = useAppContext();
  if (!runtime) {
    throw new Error('运行时尚未初始化');
  }
  return runtime;
}

export function useRuntimeState() {
  const { runtime, setRuntime } = useAppContext();
  return { runtime, setRuntime };
}
