import { describe, expect, it } from 'vitest';

import { createMemoryThemeStore, nextScheme } from '../src/theme/preference';

describe('深色模式偏好', () => {
  it('没有显式偏好时跟随系统：系统深色 → 切到浅色', () => {
    expect(nextScheme(null, 'dark')).toBe('light');
    expect(nextScheme(null, 'light')).toBe('dark');
  });

  it('已有偏好时在深浅之间来回切，不受系统影响', () => {
    expect(nextScheme('dark', 'dark')).toBe('light');
    expect(nextScheme('light', 'dark')).toBe('dark');
  });

  it('写进去的偏好能读回来（重启后仍是同一个选择）', async () => {
    const store = createMemoryThemeStore();
    expect(await store.read()).toBeNull();
    await store.write('dark');
    expect(await store.read()).toBe('dark');
  });
});
