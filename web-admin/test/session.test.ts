import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearSession, currentToken, loadSession, saveSession } from '../src/auth/session';

describe('admin session', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('保存后可读回，并提供当前令牌', () => {
    saveSession({
      accessToken: 'token-1',
      expiresAt: Date.now() + 60_000,
      username: 'admin',
      role: 'SUPER_ADMIN',
    });

    expect(loadSession()?.username).toBe('admin');
    expect(currentToken()).toBe('token-1');
  });

  it('已过期的会话视为不存在，并自动清理', () => {
    saveSession({
      accessToken: 'token-2',
      expiresAt: Date.now() - 1,
      username: 'admin',
      role: 'SUPER_ADMIN',
    });

    expect(loadSession()).toBeNull();
    expect(currentToken()).toBeNull();
    expect(localStorage.getItem('chronoflow.admin.token')).toBeNull();
  });

  it('内容损坏时不会抛出异常', () => {
    localStorage.setItem('chronoflow.admin.token', '{not-json');
    expect(loadSession()).toBeNull();
  });

  it('清除后不再返回令牌', () => {
    saveSession({
      accessToken: 'token-3',
      expiresAt: Date.now() + 60_000,
      username: 'admin',
      role: 'SUPER_ADMIN',
    });
    clearSession();
    expect(currentToken()).toBeNull();
  });

  it('localStorage 不可用时降级为未登录而不是崩溃', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => loadSession()).not.toThrow();
    expect(loadSession()).toBeNull();
    spy.mockRestore();
  });
});
