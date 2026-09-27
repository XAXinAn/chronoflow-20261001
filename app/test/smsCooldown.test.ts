import { describe, expect, it } from 'vitest';

import { SMS_COOLDOWN_SECONDS, nextCooldown, sendCodeLabel } from '../src/domain/smsCooldown';

describe('获取验证码的 60 秒倒计时', () => {
  it('冷却中显示剩余秒数，按钮不显示可点文案', () => {
    expect(sendCodeLabel(SMS_COOLDOWN_SECONDS, false)).toBe('60s 后重试');
    expect(sendCodeLabel(3, false)).toBe('3s 后重试');
  });

  it('冷却结束后回到「获取验证码」；发送中显示状态', () => {
    expect(sendCodeLabel(0, false)).toBe('获取验证码');
    expect(sendCodeLabel(0, true)).toBe('发送中…');
  });

  it('每秒递减，到 0 停住而不是变成负数', () => {
    expect(nextCooldown(60)).toBe(59);
    expect(nextCooldown(2)).toBe(1);
    expect(nextCooldown(1)).toBe(0);
    expect(nextCooldown(0)).toBe(0);
  });
});
