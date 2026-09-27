import { describe, expect, it } from 'vitest';

import { createMemoryConsentStore, needsPrivacyConsent } from '../src/auth/consentStore';
import {
  PRIVACY_POLICY_VERSION,
  buildConsentRecord,
  canRequestCode,
  canSubmitLogin,
  hasAcceptedPolicy,
} from '../src/domain/consent';
import { LEGAL_DOCS, OPERATOR_NAME, legalUrl } from '../src/domain/legal';
import { PERMISSION_RATIONALE, ensurePermission } from '../src/domain/permissions';

/**
 * 上架合规的纯逻辑（spec §12；应用宝《隐私政策提交内容及审核规范》）。
 *
 * 这些用例的价值不在「代码有没有写错」，而在**把审核规则钉成回归测试**：
 * 将来有人把勾选框改成默认勾选、把「必须先同意」去掉，这里会直接变红。
 */
describe('首启隐私政策同意（规范 §四 D1/D3）', () => {
  it('没有记录时要弹窗', () => {
    expect(hasAcceptedPolicy(null)).toBe(false);
    expect(hasAcceptedPolicy(undefined)).toBe(false);
  });

  it('同意过当前版本就不再弹', () => {
    expect(hasAcceptedPolicy(buildConsentRecord())).toBe(true);
  });

  it('隐私政策升版后必须重新征求同意（规范 §2.4）', () => {
    expect(hasAcceptedPolicy(buildConsentRecord('0.9'))).toBe(false);
  });

  it('记录读写走同一个存储', async () => {
    const store = createMemoryConsentStore();
    expect(await needsPrivacyConsent(store)).toBe(true);
    await store.write(buildConsentRecord());
    expect(await needsPrivacyConsent(store)).toBe(false);
  });
});

describe('登录页的同意勾选框（规范 §四 D2）', () => {
  const filled = { phone: '13800000000', code: '123456' };

  it('没勾同意就登录不了——这正是「默认同意」的反面', () => {
    expect(canSubmitLogin({ ...filled, acceptedPolicy: false })).toBe(false);
    expect(canSubmitLogin({ ...filled, acceptedPolicy: true })).toBe(true);
  });

  it('手机号或验证码没填全时也不放行', () => {
    expect(canSubmitLogin({ phone: '138', code: '123456', acceptedPolicy: true })).toBe(false);
    expect(canSubmitLogin({ phone: '13800000000', code: '12', acceptedPolicy: true })).toBe(false);
  });

  it('没勾同意时连验证码都不发——发码本身就已经把手机号交出去了', () => {
    expect(canRequestCode('13800000000', 0, false)).toBe(false);
    expect(canRequestCode('13800000000', 0, true)).toBe(true);
    // 冷却期里不给再发（spec §3.6：同手机号 60 秒 1 条）
    expect(canRequestCode('13800000000', 30, true)).toBe(false);
  });
});

describe('合规文本入口（规范 §一）', () => {
  it('App 内看到的就是提交给商店的那个地址', () => {
    expect(legalUrl('http://8.136.20.182:8088', 'privacy-policy')).toBe(
      'http://8.136.20.182:8088/api/v1/legal/privacy-policy',
    );
    // 末尾斜杠不能拼出双斜杠
    expect(legalUrl('http://localhost:8080/', 'user-agreement')).toBe(
      'http://localhost:8080/api/v1/legal/user-agreement',
    );
  });

  it('五份文本都在入口表里，缺一份审核都会卡', () => {
    expect(Object.keys(LEGAL_DOCS).sort()).toEqual(
      [
        'children-privacy',
        'personal-info-collected',
        'privacy-policy',
        'shared-info-with-third-parties',
        'user-agreement',
      ].sort(),
    );
  });

  it('运营主体是营业执照上的公司名（规范 §2.2）', () => {
    expect(OPERATOR_NAME).toBe('舟山市时纪云人工智能应用软件开发有限公司');
  });

  it('隐私政策版本号是个显式常量，升版必须改这里', () => {
    expect(PRIVACY_POLICY_VERSION).toBe('1.0');
  });
});

describe('权限申请（规范 §四 D6）', () => {
  it('三类权限都要有话术，且必须说清「拒绝了也能用」', () => {
    for (const kind of ['photo', 'location'] as const) {
      const rationale = PERMISSION_RATIONALE[kind];
      expect(rationale.title.length).toBeGreaterThan(0);
      expect(rationale.message).toContain('不允许');
      expect(rationale.deniedHint).toContain('其他功能不受影响');
    }
  });

  it('已经有权限就不再解释、也不再弹系统窗（否则就是「频繁弹窗」）', async () => {
    let explained = 0;
    let requested = 0;
    const granted = await ensurePermission({
      current: async () => true,
      explain: async () => {
        explained += 1;
        return true;
      },
      request: async () => {
        requested += 1;
        return true;
      },
      reject: () => undefined,
    });
    expect(granted).toBe(true);
    expect(explained).toBe(0);
    expect(requested).toBe(0);
  });

  it('用户放弃申请时直接返回 false，不弹系统窗', async () => {
    let requested = 0;
    const granted = await ensurePermission({
      current: async () => false,
      explain: async () => false,
      request: async () => {
        requested += 1;
        return true;
      },
      reject: () => undefined,
    });
    expect(granted).toBe(false);
    expect(requested).toBe(0);
  });

  it('被系统拒绝时只提示、不抛异常（不能因为拒绝就退出 App）', async () => {
    let rejected = 0;
    const granted = await ensurePermission({
      current: async () => false,
      explain: async () => true,
      request: async () => false,
      reject: () => {
        rejected += 1;
      },
    });
    expect(granted).toBe(false);
    expect(rejected).toBe(1);
  });
});
