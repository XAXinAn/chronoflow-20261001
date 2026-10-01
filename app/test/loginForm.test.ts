import { describe, expect, it } from 'vitest';

import { loginButtons } from '../src/domain/loginForm';

const READY = { canRequestCode: true, canSubmitLogin: true };

describe('登录页两个按钮的状态', () => {
  it('发码时**只有**发码按钮转圈，提交按钮不转（用户点出来的那个 bug）', () => {
    const buttons = loginButtons({ ...READY, sendingCode: true, submitting: false });
    expect(buttons.sendCode.loading).toBe(true);
    expect(buttons.submit.loading).toBe(false);
  });

  it('提交时只有提交按钮转圈，发码按钮不转', () => {
    const buttons = loginButtons({ ...READY, sendingCode: false, submitting: true });
    expect(buttons.sendCode.loading).toBe(false);
    expect(buttons.submit.loading).toBe(true);
  });

  it('空闲时两个都不转，且条件满足就可点', () => {
    const buttons = loginButtons({ ...READY, sendingCode: false, submitting: false });
    expect(buttons.sendCode).toEqual({ loading: false, disabled: false });
    expect(buttons.submit).toEqual({ loading: false, disabled: false });
  });

  it('任一请求在飞时两个都点不动（转圈 ≠ 可点）', () => {
    const sending = loginButtons({ ...READY, sendingCode: true, submitting: false });
    expect(sending.submit.disabled).toBe(true);
    const submitting = loginButtons({ ...READY, sendingCode: false, submitting: true });
    expect(submitting.sendCode.disabled).toBe(true);
  });

  it('条件不满足时按钮不可点，但仍不转圈（转圈只表示「正在进行」）', () => {
    const buttons = loginButtons({
      sendingCode: false,
      submitting: false,
      canRequestCode: false,
      canSubmitLogin: false,
    });
    expect(buttons.sendCode).toEqual({ loading: false, disabled: true });
    expect(buttons.submit).toEqual({ loading: false, disabled: true });
  });
});
