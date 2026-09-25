import { describe, expect, it } from 'vitest';

import {
  applyRefreshedTokens,
  isAccessTokenFresh,
  toStoredOrgAccount,
  type StoredOrgAccount,
} from '../src/auth/orgAccounts';

const LOGIN_RESULT = {
  account: {
    identityId: 26,
    orgId: 1,
    orgName: '心安科技',
    orgCode: 'XATECH',
    memberKey: 'E0100025',
    realName: '王思远',
    departmentName: '应用研发中心 / 应用研发部',
    orgRole: 'MEMBER',
    lastLoginAt: null,
  },
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresIn: 7200,
};

describe('组织账号的登录记录（spec §3.2 / §4.2.5）', () => {
  it('认领结果转成登录记录时带上令牌与绝对过期时间', () => {
    const stored = toStoredOrgAccount(LOGIN_RESULT, 1_000_000);

    expect(stored.identityId).toBe(26);
    expect(stored.memberKey).toBe('E0100025');
    expect(stored.accessToken).toBe('access-1');
    expect(stored.expiresAt).toBe(1_000_000 + 7200 * 1000);
  });

  it('剩余不足 5 分钟就算不新鲜：要提前刷新，别等 401', () => {
    const stored: StoredOrgAccount = { ...toStoredOrgAccount(LOGIN_RESULT, 0) };

    // 刚签发：新鲜
    expect(isAccessTokenFresh(stored, 1000)).toBe(true);
    // 还剩 4 分钟：不新鲜（留给刷新请求的余量）
    expect(isAccessTokenFresh(stored, stored.expiresAt - 4 * 60 * 1000)).toBe(false);
    // 已过期：不新鲜
    expect(isAccessTokenFresh(stored, stored.expiresAt + 1)).toBe(false);
  });

  it('刷新后的令牌要写回同一条记录，且只影响这一个组织账号', () => {
    const before = toStoredOrgAccount(LOGIN_RESULT, 0);
    const other = { ...before, identityId: 99, accessToken: 'other-access' };

    const refreshed = applyRefreshedTokens(
      before,
      {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        expiresIn: 7200,
        identity: { accountId: 1, identityId: 26, identityType: 'ORG_MEMBER', orgId: 1, nickname: '王思远' },
      },
      2_000_000,
    );

    expect(refreshed.accessToken).toBe('access-2');
    expect(refreshed.refreshToken).toBe('refresh-2');
    expect(refreshed.expiresAt).toBe(2_000_000 + 7200 * 1000);
    // 另一个组织账号的令牌不受影响：不同组织彼此隔离
    expect(other.accessToken).toBe('other-access');
  });
});
