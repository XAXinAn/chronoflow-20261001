/**
 * 登录页上**两个按钮**的「转圈 / 可点」状态（纯逻辑，可单测）。
 *
 * <p><b>为什么值得单独抽出来</b>：这里踩过一个一眼就能看出来的坑——「获取验证码」与
 * 「登录 / 注册」曾经**共用一个 `busy` 状态**，于是点「获取验证码」时两个按钮**一起转圈**。
 *
 * <p>转圈是「**这个**操作正在进行」的意思，所以它只能出现在被点的那个按钮上：
 * 发码时只有发码按钮转，提交时只有提交按钮转。把判定写成纯函数 + 单测盯着，
 * 下次谁再把状态合并回去，测试会当场红。
 */

export interface ButtonState {
  /** 该按钮自己要转圈 —— 也就是**它对应的那个请求**正在飞 */
  loading: boolean;
  disabled: boolean;
}

export interface LoginButtonsInput {
  /** 「获取验证码」的请求在飞 */
  sendingCode: boolean;
  /** 「登录 / 注册」的请求在飞 */
  submitting: boolean;
  /** {@link ./consent.canRequestCode} 的结果 */
  canRequestCode: boolean;
  /** {@link ./consent.canSubmitLogin} 的结果 */
  canSubmitLogin: boolean;
}

export interface LoginButtonsState {
  sendCode: ButtonState;
  submit: ButtonState;
}

export function loginButtons(input: LoginButtonsInput): LoginButtonsState {
  // 任何一个请求在飞，两个按钮都点不动：发码没回来就提交必然失败，只是白白弹个错
  const anyInFlight = input.sendingCode || input.submitting;
  return {
    sendCode: {
      loading: input.sendingCode,
      disabled: anyInFlight || !input.canRequestCode,
    },
    submit: {
      loading: input.submitting,
      disabled: anyInFlight || !input.canSubmitLogin,
    },
  };
}
