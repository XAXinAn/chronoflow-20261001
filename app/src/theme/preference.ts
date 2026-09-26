import type { ColorScheme } from '@xa-todo/design-tokens';

/**
 * 深色模式偏好（spec §7.6.6「App 端通过 ThemeProvider 注入，支持跟随系统深浅色切换」）。
 *
 * 之前这个偏好只活在 React state 里，App 一重启就丢——用户选了深色，下次打开又是浅色。
 * 偏好是设备级设置，跟会话无关：登出、换账号都不该把它重置。
 */
const STORAGE_KEY = 'xa-todo.scheme';

export interface ThemePreferenceStore {
  read(): Promise<ColorScheme | null>;
  write(scheme: ColorScheme): Promise<void>;
}

/** 内存实现：给单测和「存储不可用」的降级路径用。 */
export function createMemoryThemeStore(initial: ColorScheme | null = null): ThemePreferenceStore {
  let current = initial;
  return {
    async read() {
      return current;
    },
    async write(scheme) {
      current = scheme;
    },
  };
}

/**
 * 生产实现：复用已经装好的安全存储（Expo Go 里也够用，且不必再加一个依赖）。
 *
 * 动态 import 是为了让本模块在 node 环境下能被单测直接加载（与 tokenStore 同一套写法）。
 */
export async function createSecureThemeStore(): Promise<ThemePreferenceStore> {
  const SecureStore = await import('expo-secure-store');
  return {
    async read() {
      const raw = await SecureStore.getItemAsync(STORAGE_KEY);
      return raw === 'light' || raw === 'dark' ? raw : null;
    },
    async write(scheme) {
      await SecureStore.setItemAsync(STORAGE_KEY, scheme);
    },
  };
}

/**
 * 下一个配色方案：没有显式偏好时以系统当前值为起点，否则在深浅之间切换。
 */
export function nextScheme(current: ColorScheme | null, systemScheme: ColorScheme): ColorScheme {
  return (current ?? systemScheme) === 'light' ? 'dark' : 'light';
}
