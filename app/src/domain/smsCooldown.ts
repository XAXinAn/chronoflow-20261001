/**
 * 「获取验证码」的倒计时（spec §3.6：同手机号 60 秒 1 条）。
 *
 * 后端有频控，但按钮不显示倒计时的话，用户会以为没点上，一直点、一直失败——
 * 界面得把后端那条规则**提前说出来**。
 */
export const SMS_COOLDOWN_SECONDS = 60;

/** 每秒递减一次；到 0 就停下来（不再往下减成负数）。 */
export function nextCooldown(seconds: number): number {
  return seconds <= 1 ? 0 : seconds - 1;
}

/** 按钮文案：冷却中显示剩余秒数，发送中显示状态，其余才是可点的「获取验证码」。 */
export function sendCodeLabel(cooldown: number, busy: boolean): string {
  if (cooldown > 0) {
    return `${cooldown}s 后重试`;
  }
  return busy ? '发送中…' : '获取验证码';
}
