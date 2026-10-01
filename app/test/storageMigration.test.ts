import { describe, expect, it } from 'vitest';

import {
  CURRENT_KEY_PREFIX,
  LEGACY_KEY_PREFIX,
  migrateLegacyKeys,
  type StringKeyStore,
} from '../src/auth/storageMigration';

/** 内存版存储：secure-store 是原生模块，测试里用这个顶上。 */
function memoryStore(seed: Record<string, string> = {}): StringKeyStore & { data: Record<string, string> } {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    async getItemAsync(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    async setItemAsync(key, value) {
      data[key] = value;
    },
    async deleteItemAsync(key) {
      delete data[key];
    },
  };
}

/**
 * 改名（xa-todo → chronoflow）时本地存储键也要跟着改，但**不能让老用户掉登录态**。
 * 这些边界都值得钉住：搬错了轻则重登，重则把用户刚存的新值覆盖掉。
 */
describe('旧存储键的一次性迁移', () => {
  it('把旧前缀的值搬到新前缀，并删掉旧键', async () => {
    const store = memoryStore({
      [`${LEGACY_KEY_PREFIX}session`]: '{"accessToken":"t"}',
      [`${LEGACY_KEY_PREFIX}privacy-consent`]: '{"version":"1.0"}',
    });

    const moved = await migrateLegacyKeys(store);

    expect(moved).toBe(2);
    expect(store.data[`${CURRENT_KEY_PREFIX}session`]).toBe('{"accessToken":"t"}');
    expect(store.data[`${CURRENT_KEY_PREFIX}privacy-consent`]).toBe('{"version":"1.0"}');
    // 旧键必须删掉：两套键并存迟早有人改一个、读另一个
    expect(store.data[`${LEGACY_KEY_PREFIX}session`]).toBeUndefined();
  });

  it('新键已经有值时不动它（不覆盖新版本存下的数据）', async () => {
    const store = memoryStore({
      [`${LEGACY_KEY_PREFIX}session`]: 'old',
      [`${CURRENT_KEY_PREFIX}session`]: 'new',
    });

    expect(await migrateLegacyKeys(store)).toBe(0);
    expect(store.data[`${CURRENT_KEY_PREFIX}session`]).toBe('new');
    // 新键有值时不删旧键：留着（万一新值是写坏的），也不会被读
    expect(store.data[`${LEGACY_KEY_PREFIX}session`]).toBe('old');
  });

  it('什么都没存过就什么都不做', async () => {
    const store = memoryStore();
    expect(await migrateLegacyKeys(store)).toBe(0);
    expect(Object.keys(store.data)).toHaveLength(0);
  });

  it('只搬旧前缀的键，别碰其它键', async () => {
    const store = memoryStore({ 'expo-something-else': 'x' });
    await migrateLegacyKeys(store);
    expect(store.data['expo-something-else']).toBe('x');
  });
});
