import { ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { antdThemeToken, isColorScheme, type ColorScheme } from '@chronoflow/design-tokens';

const SCHEME_KEY = 'chronoflow.admin.scheme';

interface ThemeContextValue {
  scheme: ColorScheme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ scheme: 'light', toggle: () => {} });

function initialScheme(): ColorScheme {
  const stored = globalThis.localStorage?.getItem(SCHEME_KEY);
  if (stored && isColorScheme(stored)) {
    return stored;
  }
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * 通过 `data-cf-theme` 切换 CSS 变量，并把同一套令牌交给 Ant Design，
 * 保证自定义样式与组件库使用的是同一来源（spec §7.6.6）。
 */
export function CfThemeProvider({ children }: { children: ReactNode }) {
  const [scheme, setScheme] = useState<ColorScheme>(initialScheme);

  useEffect(() => {
    document.documentElement.dataset.cfTheme = scheme;
    globalThis.localStorage?.setItem(SCHEME_KEY, scheme);
  }, [scheme]);

  const toggle = useCallback(() => {
    setScheme((current) => (current === 'light' ? 'dark' : 'light'));
  }, []);

  const value = useMemo(() => ({ scheme, toggle }), [scheme, toggle]);

  return (
    <ThemeContext.Provider value={value}>
      <ConfigProvider
        locale={zhCN}
        theme={{
          algorithm: scheme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
          token: antdThemeToken(scheme),
        }}
      >
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}

export function useXaTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
